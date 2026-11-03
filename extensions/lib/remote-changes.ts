import { execFile } from "node:child_process";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const maxFileBytes = 256 * 1024;
const maxLines = 5000;
const diffOptions = ["--no-ext-diff", "--no-textconv", "--no-renames", "--no-color", "--submodule=short"];

async function git(cwd, args, maxBuffer = 1024 * 1024) {
  try {
    return (await exec("git", ["--no-optional-locks", "--no-pager", "--literal-pathspecs", "-c", "core.fsmonitor=false", ...args], {
      cwd, timeout: 3000, maxBuffer, encoding: "utf8",
    })).stdout;
  } catch (error) {
    if (error.code === "ENOENT") throw new Error("Git is not available in Pi's PATH");
    if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw new Error(maxBuffer === maxFileBytes
      ? "Diff exceeds the 256 KiB viewer limit"
      : "Git metadata exceeds the 1 MiB viewer limit. Review changes in the terminal");
    if (error.killed) throw new Error("Git took too long. Refresh or review changes in the terminal");
    throw error;
  }
}

function lines(text) {
  const result = text.split("\n");
  if (result.at(-1) === "") result.pop();
  return result;
}

async function source(root, path) {
  const target = resolve(root, path);
  let actual;
  try { actual = await realpath(target); }
  catch (error) {
    if (error.code === "ENOENT") return { message: "File is deleted or no longer exists" };
    throw error;
  }
  const inside = relative(root, actual);
  if (inside === ".." || inside.startsWith("../") || isAbsolute(inside) || actual !== target) {
    return { message: "Symbolic links are not shown" };
  }
  const file = await open(actual, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile()) return { message: "Only regular files are shown, not directories or submodules" };
    if (stat.size > maxFileBytes) return { message: "File exceeds the 256 KiB viewer limit" };
    const data = Buffer.alloc(maxFileBytes + 1);
    const { bytesRead } = await file.read(data, 0, data.length, 0);
    if (bytesRead > maxFileBytes) return { message: "File exceeds the 256 KiB viewer limit" };
    const bytes = data.subarray(0, bytesRead);
    if (bytes.includes(0)) return { message: "Binary file. Content is not shown" };
    const text = bytes.toString("utf8");
    if (lines(text).length > maxLines) return { message: "File exceeds the 5,000 line viewer limit" };
    return { text };
  } finally { await file.close(); }
}

export async function readChanges(cwd: string) {
  let root;
  try { root = (await git(cwd, ["rev-parse", "--show-toplevel"])).replace(/\n$/, ""); }
  catch (error) {
    if (error.code === 128) return { message: "No Git repository in the current session directory" };
    throw error;
  }
  root = await realpath(root);
  let head = "";
  try { head = (await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"])).trim(); }
  catch (error) { if (error.code !== 1) throw error; }
  const status = await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"]);
  const entries = status.split("\0").filter(Boolean);
  if (entries.length > 300) return { message: "More than 300 changed files. Review changes in the terminal" };
  const stats = new Map();
  if (head) {
    const summary = await git(root, ["diff", ...diffOptions, "--numstat", "-z", head, "--"]);
    for (const entry of summary.split("\0").filter(Boolean)) {
      const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(entry);
      stats.set(match[3], { added: match[1] === "-" ? null : Number(match[1]), deleted: match[2] === "-" ? null : Number(match[2]) });
    }
  }
  const files = [];
  for (const entry of entries) {
    const path = entry.slice(3);
    const untracked = entry.startsWith("??");
    let counts = stats.get(path) ?? { added: 0, deleted: 0 };
    if (untracked || !head) {
      const current = await source(root, path);
      counts = current.text !== undefined ? { added: lines(current.text).length, deleted: 0 } : { added: null, deleted: null };
    }
    files.push({ path, status: entry.slice(0, 2), untracked, ...counts });
  }
  return {
    root, head, files,
    added: files.reduce((sum, file) => sum + (file.added ?? 0), 0),
    deleted: files.reduce((sum, file) => sum + (file.deleted ?? 0), 0),
    omitted: files.filter((file) => file.added === null).length,
  };
}

export async function readChange(snapshot: Awaited<ReturnType<typeof readChanges>>, path: string, view: string) {
  if (snapshot.message) return { message: snapshot.message };
  const file = snapshot.files.find((item) => item.path === path);
  if (!file) return { message: "This file is no longer in Changes. Refresh the file list" };
  // Only paths supplied by Git status can be read, never arbitrary browser paths
  const current = await source(snapshot.root, path);
  if (view === "source") return current;
  if (file.untracked || !snapshot.head) {
    if (current.text === undefined) return current;
    const content = lines(current.text);
    const text = content.length ? ["--- /dev/null", "+++ " + path, `@@ -0,0 +1,${content.length} @@`, ...content.map((line) => "+" + line),
      ...(current.text.endsWith("\n") ? [] : ["\\ No newline at end of file"])].join("\n") : "";
    if (Buffer.byteLength(text) > maxFileBytes) return { message: "Diff exceeds the 256 KiB viewer limit" };
    if (lines(text).length > maxLines) return { message: "Diff exceeds the 5,000 line viewer limit" };
    return { text, message: content.length ? undefined : "Empty new file" };
  }
  if (current.message && current.message !== "File is deleted or no longer exists") return current;
  if (file.added === null) return { message: "Binary file. Diff is not shown" };
  const text = await git(snapshot.root, ["diff", ...diffOptions, "--unified=3", snapshot.head, "--", path], maxFileBytes);
  if (lines(text).length > maxLines) return { message: "Diff exceeds the 5,000 line viewer limit" };
  return { text, message: text ? undefined : "No changes against HEAD. Staged and unstaged edits can cancel each other" };
}
