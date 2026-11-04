import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const requestEvent = (name: string) => `jonah:remote:command:${name}`;

export interface RemoteCommandResult {
  text: string;
  error?: string;
}

export interface RemoteCommand {
  description: string;
  run: (args: string, update: (phase: string) => void, signal: AbortSignal) => Promise<RemoteCommandResult>;
}

// Only the loaded extension can advertise and execute its command
export function registerRemoteCommand(
  pi: ExtensionAPI,
  name: string,
  description: string,
  run: (args: string, ctx: ExtensionContext, update: (phase: string) => void, signal: AbortSignal) => Promise<RemoteCommandResult>,
) {
  let unsubscribe: (() => void) | undefined;
  pi.on("session_start", (_event, ctx) => {
    unsubscribe = pi.events.on(requestEvent(name), (reply: (command: RemoteCommand) => void) => {
      reply({ description, run: (args, update, signal) => run(args, ctx, update, signal) });
    });
  });
  pi.on("session_shutdown", () => { unsubscribe?.(); });
}

export function readRemoteCommand(pi: ExtensionAPI, name: string): RemoteCommand | undefined {
  let command: RemoteCommand | undefined;
  pi.events.emit(requestEvent(name), (value: RemoteCommand) => { command = value; });
  return command;
}
