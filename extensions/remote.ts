import { execFile } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { createServer as createHttpServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { isIP, type Socket } from "node:net";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import { remotePage } from "./lib/remote-page";

const exec = promisify(execFile);

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

export default function (pi: ExtensionAPI) {
  let server: Server;
  const connections = new Set<Socket>();
  let controller: AbortController;
  let link: string;
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
    await showQr(ctx, link, qrController.signal);
  }

  async function stop() {
    hideQr();
    controller?.abort();
    controller = undefined;
    link = undefined;
    live = undefined;
    const previous = server;
    server = undefined;
    if (previous) {
      await new Promise<void>((resolve) => {
        previous.close(() => resolve());
        // HTTP closeAllConnections does not close sockets still in the TLS handshake
        for (const socket of connections) socket.destroy();
      });
    }
  }

  pi.on("session_shutdown", stop);
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

  async function start(ctx: ExtensionContext, signal: AbortSignal) {
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
    const page = remotePage(nonce);
    let host: string;
    let origin: string;
    let historyLeaf: string;
    let history = [];

    async function handle(request: IncomingMessage, response: ServerResponse) {
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Referrer-Policy", "no-referrer");
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("X-Frame-Options", "DENY");
      response.setHeader("Content-Security-Policy", `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
      if (signal.aborted) return reply(response, 410, "Remote access is off");
      if (request.headers.host !== host || (request.headers.origin && request.headers.origin !== origin)) {
        return reply(response, 403, "Invalid host or origin");
      }
      const url = new URL(request.url, origin);
      if (request.method === "GET" && url.pathname === "/" && !url.search) {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return response.end(page);
      }
      if (request.headers["sec-fetch-site"] === "cross-site") return reply(response, 403, "Cross-site requests are not allowed");
      if (request.method === "POST" && request.headers.origin !== origin) return reply(response, 403, "A same-origin request is required");
      if (request.method === "POST" && url.pathname === "/auth") {
        if (!matches(request.headers.authorization, `Bearer ${token}`)) return reply(response, 401, "Invalid remote link");
        hideQr();
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        return response.end(JSON.stringify({ accessToken }));
      }
      if (!matches(request.headers.authorization, `Bearer ${accessToken}`)) return reply(response, 401, "Open the link from /remote in the terminal");
      if (request.method === "GET" && url.pathname === "/state") {
        hideQr();
        const leaf = ctx.sessionManager.getLeafId() ?? "root";
        const state = compacting ? "Compacting" : waiting ? "Waiting for a terminal dialog" : ctx.isIdle() ? "Idle" : "Working";
        const pending = ctx.hasPendingMessages();
        const version = `${leaf}:${liveVersion}:${state}:${pending}`;
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
          version, leaf, state, pending, live: live ? messageView(live) : null,
          ...(url.searchParams.get("leaf") !== leaf ? { history } : {}),
        }));
      }
      if (request.method === "POST" && url.pathname === "/stop") {
        ctx.abort();
        return reply(response, 202, "Stop requested. Check the terminal for dialogs and queued prompts");
      }
      if (request.method === "POST" && url.pathname === "/prompt") {
        if (request.headers["content-type"] !== "application/json") return reply(response, 415, "Expected application/json");
        const chunks = [];
        let bytes = 0;
        for await (const chunk of request) {
          bytes += chunk.length;
          if (bytes > 64 * 1024) return reply(response, 413, "Prompt is too large (64 KiB limit)");
          chunks.push(chunk);
        }
        // Session shutdown or /remote off can occur while the request body is arriving
        if (signal.aborted) return reply(response, 410, "Remote access is off");
        if (compacting) return reply(response, 409, "Wait for compaction to finish, then send again");
        const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (typeof input?.text !== "string" || !input.text.trim()) return reply(response, 400, "Enter a plain text prompt");
        if (input.text.trimStart().startsWith("/")) return reply(response, 400, "Slash commands are not supported. Use the Pi terminal");
        pi.sendUserMessage(input.text, { deliverAs: "followUp", expandPromptTemplates: false });
        return reply(response, 202, "Submitted to Pi. If busy, Pi queues it as a follow-up");
      }
      return reply(response, 404, "Not found");
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
      connections.add(socket);
      socket.on("close", () => connections.delete(socket));
    });
    next.requestTimeout = 10_000;
    next.headersTimeout = 10_000;
    server = next;
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
    link = `${origin}/#${token}`;
    ctx.ui.notify(`Remote access controls this Pi session with its full permissions. Keep the link private\n${https ? "HTTPS on Tailscale" : "HTTP on Tailscale encrypted transport, NOT browser HTTPS"}`, "warning");
  }

  pi.registerCommand("remote", {
    description: "Open this session in a private Tailscale browser, /remote hide, or /remote off",
    handler: async (args, ctx) => {
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
      if (controller) {
        ctx.ui.notify(link ? "Remote access is on" : "Remote access is starting", "info");
        if (link) await displayQr(ctx);
        return;
      }
      controller = new AbortController();
      const signal = controller.signal;
      try {
        await start(ctx, signal);
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
