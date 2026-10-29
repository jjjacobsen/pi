import { defineTool, resizeImage } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Type } from "typebox";
import { imageFormat } from "./image-providers";

// The worker captures with its CLI, then explicitly publishes the saved evidence.
export function screenshotArtifacts(cwd: string) {
  const paths = [];
  let preview;
  const content = () => paths.length ? [
    { type: "text" as const, text: `Screenshots:\n${paths.join("\n")}\n${preview ? "Preview only. Saved files retain their original resolution." : "Preview unavailable. Use read to inspect the saved image."}` },
    ...(preview ? [preview] : []),
  ] : [];

  const tool = defineTool({
    name: "screenshot_artifact",
    label: "Screenshot evidence",
    description: "Publish an existing screenshot captured for this task. Returns its absolute file path and a reduced preview of the first screenshot to you and the calling agent. Does not capture the screen. Only publish evidence the task authorizes sharing with both model providers",
    parameters: Type.Object({
      path: Type.String({ minLength: 1, description: "Saved screenshot path, absolute or relative to the project" }),
    }),
    async execute(_id, params) {
      const path = resolve(cwd, params.path);
      const bytes = await readFile(path);
      const { mimeType } = imageFormat(bytes);
      const first = !paths.length;
      if (!paths.includes(path)) {
        if (first) {
          const resized = await resizeImage(bytes, mimeType, { maxWidth: 1024, maxHeight: 1024, maxBytes: 1_000_000 });
          if (resized) preview = { type: "image" as const, mimeType: resized.mimeType, data: resized.data };
        }
        paths.push(path);
      }
      return {
        content: [{ type: "text" as const, text: `Screenshot saved: ${path}` }, ...(first && preview ? [preview] : [])],
        details: { paths: [...paths] },
      };
    },
  });
  return { tool, content, paths };
}
