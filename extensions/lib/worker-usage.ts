export function sumUsage(session) {
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  for (const entry of session.sessionManager.getEntries()) {
    const usage = entry.type === "message" ? entry.message.usage : entry.usage;
    if (!usage) continue;
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) total[key] += usage[key];
    for (const key of ["reasoning", "cacheWrite1h"]) {
      if (usage[key] !== undefined) total[key] = (total[key] ?? 0) + usage[key];
    }
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"]) total.cost[key] += usage.cost[key];
  }
  return total;
}
