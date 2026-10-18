function parseSnapshot(snapshot: string) {
  return snapshot.split("\n").map((line) => {
    const match = line.match(/^(\s*)-\s+([\w-]+)(?:\s+("(?:[^"\\]|\\.)*"))?(.*)$/);
    const tail = match?.[4] ?? "";
    const metadata = tail.match(/^(?:\s*\[[^\]]*\]|\s+clickable)*/)?.[0] ?? "";
    const flags = [...metadata.matchAll(/\[([^\]]*)\]/g)].flatMap((flag) => flag[1].split(/,\s*/));
    return {
      line,
      indent: line.length - line.trimStart().length,
      role: match?.[2],
      name: match?.[3] ? JSON.parse(match[3]) as string : undefined,
      ref: flags.flatMap((part) => part.trim().split(/\s+/)).find((part) => /^ref=e\d+$/.test(part))?.slice(4),
      context: metadata,
    };
  });
}

export function snapshotTargetSignature(snapshot: string, ref: string): string | undefined {
  const lines = parseSnapshot(snapshot);
  const index = lines.findIndex((line) => line.ref === ref.replace(/^@/, ""));
  if (index === -1) return undefined;
  const subtree = (start: number) => {
    let end = start + 1;
    while (end < lines.length && lines[end].indent > lines[start].indent) end++;
    return lines.slice(start, end).map((line) => line.line).join("\n");
  };
  const context = (target: number) => {
    const parents = [];
    let indent = lines[target].indent;
    for (let parent = target - 1; parent >= 0; parent--) {
      if (lines[parent].indent >= indent) continue;
      parents.unshift(["row", "listitem"].includes(lines[parent].role) ? subtree(parent) : lines[parent].line);
      indent = lines[parent].indent;
    }
    const heading = lines.slice(0, target).findLast((line) => line.role === "heading");
    return [...parents, heading?.line ?? "", subtree(target)].join("\n");
  };
  const signature = context(index);
  const semantic = (text: string) => text.replace(/ref=e\d+/g, "ref=*");
  if (lines.some((line, other) => other !== index && line.ref && line.role === lines[index].role && line.name === lines[index].name && semantic(context(other)) === semantic(signature))) return undefined;
  return signature;
}

// Local text selection only. Native refs and the browser's ref map stay unchanged.
export function focusSnapshot(snapshot: string, maxLines = 160) {
  const nodes = parseSnapshot(snapshot);
  if (nodes.length <= maxLines) return snapshot;
  const focus = new Set<number>();
  for (const [index, node] of nodes.entries()) {
    if (!["dialog", "alertdialog", "listbox", "menu"].includes(node.role) || /\[hidden(?:=true)?\]/.test(node.context)) continue;
    focus.add(index);
    for (let child = index + 1; child < nodes.length && nodes[child].indent > node.indent; child++) focus.add(child);
  }
  const priority = (index: number) => {
    const node = nodes[index];
    if (focus.has(index)) return 0;
    if (["heading", "main", "document", "alert", "status"].includes(node.role)) return 1;
    return 2;
  };
  // Within each region, alternate controls and evidence to retain both on long pages.
  const context = nodes.map((_, index) => index).filter((index) => priority(index) === 1 || index < 3).slice(0, Math.min(8, Math.floor(maxLines / 4)));
  const ordered: number[] = [...context];
  for (const level of [0, 1, 2]) {
    const indices = nodes.map((_, index) => index).filter((index) => priority(index) === level && !context.includes(index));
    const controls = indices.filter((index) => nodes[index].ref);
    const evidence = indices.filter((index) => !nodes[index].ref);
    for (let index = 0; index < Math.max(controls.length, evidence.length); index++) {
      if (index < evidence.length) ordered.push(evidence[index]);
      if (index < controls.length) ordered.push(controls[index]);
    }
  }
  const kept = new Set<number>();
  for (const index of ordered) {
    const branch = [index];
    let indent = nodes[index].indent;
    for (let parent = index - 1; parent >= 0 && indent > 0; parent--) {
      if (nodes[parent].indent >= indent) continue;
      branch.push(parent);
      indent = nodes[parent].indent;
    }
    const missing = branch.filter((line) => !kept.has(line));
    if (kept.size + missing.length <= maxLines) missing.forEach((line) => kept.add(line));
  }
  return `[Focused view: ${kept.size} of ${nodes.length} lines. Read a relevant ref for omitted evidence.]\n${[...kept].sort((a, b) => a - b).map((index) => nodes[index].line).join("\n")}`;
}
