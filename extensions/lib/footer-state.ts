import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface FooterState {
  cwd: string;
  branch: string | null;
  gitStatus: string;
  context: string;
  contextColor: "dim" | "warning" | "error";
  model: string;
  modelProvider: string;
  reasoning: string;
}

// The footer answers synchronously with plain display data, never SDK objects
export const FOOTER_STATE_REQUEST = "jonah:footer:state";

export function readFooterState(pi: ExtensionAPI): FooterState | null {
  let state: FooterState | null = null;
  pi.events.emit(FOOTER_STATE_REQUEST, (value: FooterState | null) => { state = value; });
  return state;
}
