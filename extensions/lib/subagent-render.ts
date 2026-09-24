import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const params = Type.Object({ label: Type.String(), task: Type.String(), model: Type.Optional(Type.String()), reasoning: Type.Optional(Type.String()) });

// Keep untrusted task, tool activity, and output from writing terminal controls.
function clean(text: string) {
  return stripTerminalSequences(text).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
}

function cleanLines(text: string) {
  return stripTerminalSequences(text).replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, " ");
}

function lines(text: string, width: number, wrap = false) {
  if (width <= 0) return [];
  return text.split("\n").flatMap((line) =>
    (wrap ? wrapTextWithAnsi(line, width) : [line]).map((part) => truncateToWidth(part, width)),
  );
}

function component(render: (width: number) => string[]) {
  return { render, invalidate() {} };
}

function elapsed(ms: number) {
  const seconds = Math.floor(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export const renderSubagentCall: NonNullable<ToolDefinition<typeof params>["renderCall"]> = (args, theme, context) => {
  return component((width) => {
    const status = context.state.latest?.status ?? "running";
    const symbol = status === "done" ? theme.fg("success", "✓") : status === "failed" ? theme.fg("error", "✗")
      : status === "cancelled" ? theme.fg("warning", "■") : theme.fg("warning", "◌");
    const label = clean(context.state.latest?.label ?? args.label ?? args.task ?? "");
    const header = symbol + " " + theme.fg("toolTitle", theme.bold("Subagent")) + " " + theme.fg("accent", label);
    return width > 0 ? [truncateToWidth(header, width)] : [];
  });
};

export const renderSubagentResult: NonNullable<ToolDefinition<typeof params>["renderResult"]> = (result, { expanded, isPartial }, theme, context) => {
  if (result.details && Object.keys(result.details).length) context.state.latest = result.details;
  const details = context.state.latest ?? {};
  // Pi's native failure result can omit details. The last progress update keeps metadata.
  if (!isPartial && context.isError) context.state.latest = { ...details, status: details.status === "cancelled" ? "cancelled" : "failed" };

  return component((width) => {
    if (width <= 0) return [];
    const current = context.state.latest ?? {};
    const status = !isPartial && context.isError && current.status !== "cancelled" ? "failed" : current.status ?? (isPartial ? "running" : "done");
    const meta = [current.model, current.reasoning && `thinking ${current.reasoning}`, current.elapsedMs !== undefined && elapsed(current.elapsedMs)]
      .filter(Boolean).map(clean).join(" · ");
    const output = result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
    const rendered = [];
    if (meta) rendered.push(...lines(theme.fg("dim", meta), width));
    if (status === "running" && current.activity) rendered.push(...lines(theme.fg("muted", `↳ ${clean(current.activity)}`), width));
    if (!expanded) return rendered;

    rendered.push(...lines(theme.fg("muted", "Task"), width));
    rendered.push(...lines(theme.fg("toolOutput", cleanLines(current.task ?? context.args.task ?? "")), width, true));
    if (output) {
      rendered.push(...lines(theme.fg("muted", "Output"), width));
      rendered.push(...lines(theme.fg(status === "failed" ? "error" : "toolOutput", cleanLines(output)), width, true));
    }
    const usage = current.usage ?? result.usage;
    if (usage) {
      const stats = [usage.input !== undefined && `in ${usage.input}`, usage.output !== undefined && `out ${usage.output}`,
        usage.cacheRead !== undefined && `cache read ${usage.cacheRead}`, usage.cacheWrite !== undefined && `cache write ${usage.cacheWrite}`,
        usage.cost?.total !== undefined && `$${usage.cost.total.toFixed(4)}`].filter(Boolean).join(" · ");
      rendered.push(...lines(theme.fg("dim", `Usage: ${stats}`), width));
    }
    if (current.transcript) rendered.push(...lines(theme.fg("dim", `Transcript: ${clean(current.transcript)}`), width, true));
    return rendered;
  });
};
