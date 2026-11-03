import { execFile } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { createServer as createHttpServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { isIP, type Socket } from "node:net";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { resizeImage, SessionManager, type ExtensionAPI, type ExtensionContext, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import { remotePage } from "./lib/remote-page";
import { readChange, readChanges } from "./lib/remote-changes";
import { readFooterState } from "./lib/footer-state";
import { imageFormat } from "./lib/image-providers";

const exec = promisify(execFile);
const maxTextBytes = 64 * 1024;
const maxImageBytes = 10 * 1024 * 1024;
const maxPromptBytes = 15 * 1024 * 1024;

// The transport belongs to this Pi process, not to a replaceable extension runtime
const accessKey = Symbol.for("jonah.pi.remote");
interface RemoteAccess {
  server?: Server;
  controller?: AbortController;
  link?: string;
  connections: Set<Socket>;
  renderPage: typeof remotePage;
  handle?: (request: IncomingMessage, response: ServerResponse, url: URL) => Promise<unknown>;
  hideQr?: () => void;
  transition?: string;
}
const processState = globalThis as typeof globalThis & { [accessKey]?: RemoteAccess };

const builtins = [
  { name: "new", description: "Start a new session" },
  { name: "reload", description: "Reload Pi resources" },
  { name: "resume", description: "Choose a saved session" },
];

async function showQr(ctx: ExtensionContext, link: string, signal: AbortSignal) {
  const helpText = `Scan with a phone on Tailscale. Keep this code and link private\n${link}\nKeep typing below. /remote hide hides this code, /remote off stops access`;
  const help = new Text(helpText, 0, 0);
  ctx.ui.setWidget("remote-qr", () => help);
  let stdout: string;
  try {
    const result = exec("qrencode", ["-t", "UTF8i", "-m", "4"], { timeout: 5000, signal, maxBuffer: 128 * 1024 });
    // Keep the private URL out of process arguments and command errors
    result.child.stdin.end(link);
    ({ stdout } = await result);
  } catch {
    if (!signal.aborted) ctx.ui.notify("QR code unavailable. Check qrencode in PATH or use the text link", "warning");
    return;
  }
  if (signal.aborted) return;
  const qr = stdout.replace(/\n$/, "").split("\n").map((line) => `\x1b[0;38;2;0;0;0;48;2;255;255;255m${line}\x1b[0m`);
  const qrWidth = visibleWidth(qr[0]);
  ctx.ui.setWidget("remote-qr", (tui) => ({
    render(width) {
      const footer = help.render(width);
      // Leave room for the editor, footer, and conversation instead of covering them
      if (width < qrWidth || tui.terminal.rows < qr.length + footer.length + 10) {
        return new Text(`Enlarge the terminal to show the QR code, or use the text link\n${helpText}`, 0, 0).render(width);
      }
      return [...qr, ...footer];
    },
    invalidate() { help.invalidate(); },
  }));
}

function text(content) {
  if (typeof content === "string") return content;
  return content.map((block) => {
    if (block.type === "text") return block.text;
    if (block.type === "image") return "[Image omitted]";
    if (block.type === "toolCall") return `[Tool: ${block.name}]`;
    return "";
  }).filter(Boolean).join("\n");
}

function messageView(message: AgentMessage) {
  switch (message.role) {
    case "user":
      return { role: "You", text: text(message.content) };
    case "assistant":
      return { role: "Pi", text: [text(message.content), message.errorMessage].filter(Boolean).join("\n") };
    case "toolResult":
      return { role: `${message.toolName}${message.isError ? " (error)" : ""}`, text: text(message.content) };
    case "custom":
      return message.display ? { role: message.customType, text: text(message.content) } : undefined;
    case "bashExecution":
      return { role: "Terminal command", text: `${message.command}\n${message.output}` };
    case "branchSummary":
      return { role: "Branch summary", text: message.summary };
    default:
      return undefined;
  }
}

function matches(value, secret) {
  if (typeof value !== "string") return false;
  const bytes = Buffer.from(value);
  const expected = Buffer.from(secret);
  return bytes.length === expected.length && timingSafeEqual(bytes, expected);
}

function reply(response: ServerResponse, status, body = "") {
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  response.end(body);
}

// Listener callbacks retain only process-owned transport data, never an SDK context
async function start(access: RemoteAccess, signal: AbortSignal) {
  const status = await exec("tailscale", ["status", "--json"], { timeout: 10_000, signal, maxBuffer: 1024 * 1024 });
  const tailnet = JSON.parse(status.stdout);
  const ip = tailnet.Self?.TailscaleIPs?.find((address) => isIP(address) === 4);
  const octets = ip?.split(".").map(Number);
  if (tailnet.BackendState !== "Running" || !octets || octets[0] !== 100 || octets[1] < 64 || octets[1] > 127) {
    throw new Error("A connected Tailscale IPv4 address is required");
  }
  const domain = tailnet.Self.DNSName?.replace(/\.$/, "");
  const https = domain && tailnet.CertDomains?.includes(domain);
  let pem: string;
  if (https) {
    const certificate = await exec("tailscale", ["cert", "--cert-file", "-", "--key-file", "-", domain], {
      timeout: 60_000, signal, maxBuffer: 64 * 1024,
    });
    pem = certificate.stdout;
  }
  signal.throwIfAborted();
  const token = randomBytes(32).toString("hex");
  const accessToken = randomBytes(32).toString("hex");
  const nonce = randomBytes(16).toString("hex");
  let host: string;
  let origin: string;

  async function handle(request: IncomingMessage, response: ServerResponse) {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Content-Security-Policy", `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
    if (signal.aborted) return reply(response, 410, "Remote access is off");
    if (request.headers.host !== host || (request.headers.origin && request.headers.origin !== origin)) {
      return reply(response, 403, "Invalid host or origin");
    }
    const url = new URL(request.url, origin);
    if (request.method === "GET" && url.pathname === "/" && !url.search) {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return response.end(access.renderPage(nonce));
    }
    if (request.headers["sec-fetch-site"] === "cross-site") return reply(response, 403, "Cross-site requests are not allowed");
    if (request.method === "POST" && request.headers.origin !== origin) return reply(response, 403, "A same-origin request is required");
    if (request.method === "POST" && url.pathname === "/auth") {
      if (!matches(request.headers.authorization, `Bearer ${token}`)) return reply(response, 401, "Invalid remote link");
      access.hideQr?.();
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return response.end(JSON.stringify({ accessToken }));
    }
    if (!matches(request.headers.authorization, `Bearer ${accessToken}`)) return reply(response, 401, "Open the link from /remote in the terminal");
    if (access.handle) return access.handle(request, response, url);
    if (request.method === "GET" && url.pathname === "/state") {
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return response.end(JSON.stringify({ version: "", state: access.transition, pending: false, live: null, footer: null }));
    }
    return reply(response, 503, access.transition);
  }

  const listener = (request, response) => {
    handle(request, response).catch((error) => {
      if (response.destroyed) return;
      if (!response.headersSent) reply(response, error instanceof SyntaxError ? 400 : 500, error instanceof SyntaxError ? "Invalid JSON" : "Remote request failed. Check the Pi terminal");
      else response.destroy();
    });
  };
  const next = https ? createHttpsServer({ cert: pem, key: pem, maxHeaderSize: 8192 }, listener) : createHttpServer({ maxHeaderSize: 8192 }, listener);
  next.on("connection", (socket) => {
    access.connections.add(socket);
    socket.on("close", () => access.connections.delete(socket));
  });
  next.requestTimeout = 60_000;
  next.headersTimeout = 10_000;
  access.server = next;
  await new Promise<void>((resolve, reject) => {
    next.once("error", reject);
    next.listen(0, ip, () => {
      next.removeListener("error", reject);
      resolve();
    });
  });
  signal.throwIfAborted();
  const address = next.address();
  if (typeof address !== "object" || !address) throw new Error("Remote listener has no address");
  host = `${https ? domain : ip}:${address.port}`;
  origin = `${https ? "https" : "http"}://${host}`;
  access.link = `${origin}/#${token}`;
  return https;
}

export default function (pi: ExtensionAPI) {
  const access = processState[accessKey] ??= { connections: new Set(), renderPage: remotePage };
  const commands = new Map<string, { text: string; resolve: (message: string) => void; reject: (error: Error) => void }>();
  let commandRunning = false;
  let live: AgentMessage;
  let liveVersion = 0;
  let compacting = false;
  let waiting = false;
  let qrController: AbortController;
  let qrContext: ExtensionContext;

  function hideQr() {
    qrController?.abort();
    qrController = undefined;
    qrContext?.ui.setWidget("remote-qr", undefined);
    qrContext = undefined;
  }

  async function displayQr(ctx: ExtensionContext) {
    hideQr();
    qrController = new AbortController();
    qrContext = ctx;
    await showQr(ctx, access.link, qrController.signal);
  }

  async function stop() {
    hideQr();
    access.controller?.abort();
    access.controller = undefined;
    access.link = undefined;
    live = undefined;
    const previous = access.server;
    access.server = undefined;
    if (previous) {
      await new Promise<void>((resolve) => {
        previous.close(() => resolve());
        // HTTP closeAllConnections does not close sockets still in the TLS handshake
        for (const socket of access.connections) socket.destroy();
      });
    }
  }

  pi.on("session_shutdown", async (event) => {
    hideQr();
    // Never retain session-bound SDK objects after replacement
    access.handle = undefined;
    access.hideQr = undefined;
    if (event.reason === "quit") await stop();
    else access.transition = event.reason === "reload" ? "Reloading" : "Switching session";
  });
  pi.on("message_start", (event) => {
    if (event.message.role === "assistant") {
      live = event.message;
      liveVersion++;
    }
  });
  pi.on("message_update", (event) => {
    live = event.message;
    liveVersion++;
  });
  pi.on("message_end", (event) => {
    if (event.message.role === "assistant") {
      live = undefined;
      liveVersion++;
    }
  });
  pi.on("session_before_compact", () => { compacting = true; });
  pi.on("session_compact", () => { compacting = false; });
  pi.on("session_compact_failed", () => { compacting = false; });
  pi.on("session_tree", () => { live = undefined; liveVersion++; });
  pi.on("ui_prompt_start", () => { waiting = true; });
  pi.on("ui_prompt_end", () => { waiting = false; });

  function commandList() {
    // getCommands contains extension, prompt, and skill commands, not TUI built-ins
    return [...builtins, ...pi.getCommands().filter((command) => !builtins.some(({ name }) => command.name === name))]
      .map(({ name, description }) => ({ name, description }));
  }

  async function executeCommand(value: string, ctx: ExtensionCommandContext) {
    const [name, ...args] = value.slice(1).split(/\s+/);
    if (name === "new") {
      if (args.length) throw new Error("Usage: /new");
      return (await ctx.newSession()).cancelled ? "New session cancelled" : "New session started";
    }
    if (name === "reload") {
      if (args.length) throw new Error("Usage: /reload");
      await ctx.reload();
      return "Reloaded";
    }
    if (name === "resume") {
      const sessions = await SessionManager.list(ctx.cwd, ctx.sessionManager.getSessionDir());
      const selected = sessions.find((session) => session.id === args[0]);
      if (args.length !== 1 || !selected) throw new Error("Choose a saved session in the browser");
      return (await ctx.switchSession(selected.path)).cancelled ? "Resume cancelled" : "Session resumed";
    }
    pi.sendUserMessage(value, { expandPromptTemplates: true });
    return "Command submitted. Check the terminal for dialogs";
  }

  pi.on("session_start", (_event, ctx) => {
    live = undefined;
    liveVersion = 0;
    compacting = false;
    waiting = false;
    let historyLeaf: string;
    let history = [];
    access.transition = undefined;
    access.renderPage = remotePage;
    access.hideQr = hideQr;
    const workspace = randomBytes(16).toString("hex");
    const handle = async (request: IncomingMessage, response: ServerResponse, url: URL) => {
      if (request.method === "GET" && url.pathname === "/changes") {
        if (url.searchParams.get("workspace") !== workspace) return reply(response, 409, "Session changed. Wait for the current session, then refresh Changes");
        const path = url.searchParams.get("path");
        const view = url.searchParams.get("view");
        if (path !== null && !["diff", "source"].includes(view)) return reply(response, 400, "Choose Diff or Source");
        let result;
        try {
          const snapshot = await readChanges(ctx.cwd);
          if (access.handle !== handle) return reply(response, 409, "Session changed. Refresh Changes");
          if (path !== null) result = await readChange(snapshot, path, view);
          else {
            const { root, head, ...summary } = snapshot;
            result = { ...summary, repository: root, hasHead: !!head };
          }
        } catch (error) {
          if (access.handle !== handle) return reply(response, 409, "Session changed. Refresh Changes");
          return reply(response, 400, error.code ? "Cannot read Git changes. Refresh or review them in the terminal" : error.message);
        }
        if (access.handle !== handle) return reply(response, 409, "Session changed. Refresh Changes");
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        return response.end(JSON.stringify({ workspace, ...result }));
      }
      if (request.method === "GET" && url.pathname === "/commands") {
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        return response.end(JSON.stringify(commandList()));
      }
      if (request.method === "GET" && url.pathname === "/sessions") {
        const currentId = ctx.sessionManager.getSessionId();
        const sessions = await SessionManager.list(ctx.cwd, ctx.sessionManager.getSessionDir());
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        return response.end(JSON.stringify(sessions.map(({ id, name, firstMessage, modified, messageCount }) => ({
          id, name: name || firstMessage || "Empty session", modified, messageCount,
          current: id === currentId,
        }))));
      }
      if (request.method === "GET" && url.pathname === "/state") {
        hideQr();
        const leaf = `${ctx.sessionManager.getSessionId()}:${ctx.sessionManager.getLeafId() ?? "root"}`;
        const state = compacting ? "Compacting" : waiting ? "Waiting for a terminal dialog" : ctx.isIdle() ? "Idle" : "Working";
        const pending = ctx.hasPendingMessages();
        const footer = readFooterState(pi);
        const version = `${workspace}:${leaf}:${liveVersion}:${state}:${pending}:${JSON.stringify(footer)}`;
        if (url.searchParams.get("version") === version) return reply(response, 204);
        if (leaf !== historyLeaf) {
          // Raw active-branch history retains old messages across compaction, unlike model context
          history = ctx.sessionManager.getBranch().map((entry) => {
            if (entry.type === "message") return messageView(entry.message);
            if (entry.type === "custom_message" && entry.display) return { role: entry.customType, text: text(entry.content) };
            if (entry.type === "compaction") return { role: "Compaction", text: "Model context compacted. Earlier messages remain in this history" };
            if (entry.type === "branch_summary") return { role: "Branch summary", text: entry.summary };
          }).filter(Boolean);
          historyLeaf = leaf;
        }
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        return response.end(JSON.stringify({
          version, leaf, workspace, state, pending, footer, live: live ? messageView(live) : null,
          ...(url.searchParams.get("leaf") !== leaf ? { history } : {}),
        }));
      }
      if (request.method === "POST" && url.pathname === "/stop") {
        ctx.abort();
        return reply(response, 202, "Stop requested. Check the terminal for dialogs and queued prompts");
      }
      if (request.method === "POST" && (url.pathname === "/prompt" || url.pathname === "/command")) {
        if (request.headers["content-type"] !== "application/json") return reply(response, 415, "Expected application/json");
        const limit = url.pathname === "/prompt" ? maxPromptBytes : maxTextBytes;
        const chunks = [];
        let bytes = 0;
        for await (const chunk of request) {
          bytes += chunk.length;
          if (bytes > limit) return reply(response, 413, url.pathname === "/prompt" ? "Request is too large (15 MiB limit)" : "Command is too large (64 KiB limit)");
          chunks.push(chunk);
        }
        // Do not submit a body to a session that was replaced while it arrived
        if (access.handle !== handle) return reply(response, 409, "Session changed. Check the current session, then send again");
        if (compacting) return reply(response, 409, "Wait for compaction to finish, then send again");
        const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (typeof input?.text !== "string") return reply(response, 400, "Expected prompt text, or an empty caption with one image");
        if (Buffer.byteLength(input.text, "utf8") > maxTextBytes) return reply(response, 413, "Text is too large (64 KiB limit)");
        const hasImage = input.image !== undefined;
        if (!hasImage && bytes > maxTextBytes) return reply(response, 413, "Text request is too large (64 KiB limit)");
        if (hasImage && (url.pathname === "/command" || input.text.trimStart().startsWith("/"))) {
          return reply(response, 400, "Images cannot be attached to slash commands. Remove the image first");
        }
        if (!input.text.trim() && !hasImage) return reply(response, 400, "Enter a prompt or attach one image");
        if (url.pathname === "/command") {
          const value = input.text.trim();
          const name = value.split(/\s+/, 1)[0].slice(1);
          if (!value.startsWith("/") || !commandList().some((command) => command.name === name)) return reply(response, 400, "Command is not available remotely");
          if (!ctx.isIdle() || compacting || waiting || commandRunning) return reply(response, 409, "Wait for Pi and any terminal dialog to finish");
          commandRunning = true;
          try {
            // Only command handlers receive the supported session-control context
            const result = await new Promise<string>((resolve, reject) => {
              const id = randomBytes(16).toString("hex");
              commands.set(id, { text: value, resolve, reject });
              pi.sendUserMessage(`/remote run ${id}`, { expandPromptTemplates: true });
            });
            return reply(response, 200, result);
          } catch (error) {
            return reply(response, 400, error.message);
          } finally { commandRunning = false; }
        }
        if (input.text.trimStart().startsWith("/")) return reply(response, 400, "Use the command menu for slash commands");
        let image;
        if (hasImage) {
          if (pi.getSettings().images?.blockImages) return reply(response, 400, "Images are blocked by Pi's images.blockImages setting");
          const model = ctx.model;
          if (!model?.input.includes("image")) return reply(response, 400, "The selected model does not support image input. Select an image-capable model in the terminal");
          const source = input.image;
          if (!["image/png", "image/jpeg", "image/webp"].includes(source?.mimeType)) return reply(response, 400, "Attach one PNG, JPEG, or WebP image");
          if (typeof source.data !== "string" || !source.data.length) return reply(response, 400, "Expected base64 image data");
          if (source.data.length > Math.ceil(maxImageBytes / 3) * 4) return reply(response, 413, "Image is too large (10 MiB limit)");
          const data = Buffer.from(source.data, "base64");
          if (data.toString("base64") !== source.data) return reply(response, 400, "Invalid base64 image data");
          if (data.length > maxImageBytes) return reply(response, 413, "Image is too large (10 MiB limit)");
          try {
            if (imageFormat(data).mimeType !== source.mimeType) return reply(response, 400, "Image data does not match its PNG, JPEG, or WebP media type");
            // Queued follow-ups can skip Pi's automatic image resizing
            image = await resizeImage(data, source.mimeType, model.inputLimits?.images?.resize);
          } catch {
            return reply(response, 400, "Cannot read this image as PNG, JPEG, or WebP. Choose another image");
          }
          if (!image) return reply(response, 400, "Cannot decode or resize this image. Choose a valid PNG, JPEG, or WebP image");
          if (access.handle !== handle) return reply(response, 409, "Session changed. Check the current session, then send again");
          if (compacting) return reply(response, 409, "Wait for compaction to finish, then send again");
          if (ctx.model !== model) return reply(response, 409, "Model changed. Check the selected model, then send again");
          if (pi.getSettings().images?.blockImages) return reply(response, 400, "Images are blocked by Pi's images.blockImages setting");
        }
        pi.sendUserMessage(image ? [
          ...(input.text.trim() ? [{ type: "text" as const, text: input.text }] : []),
          { type: "image", data: image.data, mimeType: image.mimeType },
        ] : input.text, { deliverAs: "followUp", expandPromptTemplates: false });
        return reply(response, 202, "Submitted to Pi. If busy, Pi queues it as a follow-up");
      }
      return reply(response, 404, "Not found");
    };

    access.handle = handle;
  });

  pi.registerCommand("remote", {
    description: "Open this session in a private Tailscale browser, /remote hide, or /remote off",
    handler: async (args, ctx) => {
      const id = args.trim().slice(4);
      const pending = args.startsWith("run ") ? commands.get(id) : undefined;
      if (pending) {
        commands.delete(id);
        try { pending.resolve(await executeCommand(pending.text, ctx)); }
        catch (error) { pending.reject(error); }
        return;
      }
      if (args.trim() === "hide") {
        hideQr();
        return;
      }
      if (args.trim() === "off") {
        await stop();
        ctx.ui.notify("Remote access is off", "info");
        return;
      }
      if (args.trim()) return ctx.ui.notify("Usage: /remote [hide|off]", "warning");
      if (ctx.mode !== "tui") return ctx.ui.notify("/remote requires the Pi terminal", "warning");
      if (access.controller) {
        ctx.ui.notify(access.link ? "Remote access is on" : "Remote access is starting", "info");
        if (access.link) await displayQr(ctx);
        return;
      }
      access.controller = new AbortController();
      const signal = access.controller.signal;
      try {
        const https = await start(access, signal);
        ctx.ui.notify(`Remote access controls this Pi process with its full permissions. Keep the link private\n${https ? "HTTPS on Tailscale" : "HTTP on Tailscale encrypted transport, NOT browser HTTPS"}`, "warning");
      } catch (error) {
        if (signal.aborted) return;
        await stop();
        ctx.ui.notify(error.message, "error");
        return;
      }
      await displayQr(ctx);
    },
  });
}
