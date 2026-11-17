// What an agent's session has cost so far, from its transcript. Pure functions, no host calls: testable
// with plain `bun`. Each takes the WHOLE transcript (a tail would undercount) and returns dollars or null.
//
// omp and Claude Code price every request at API list prices, also when a subscription covers the model
// (the caller marks those as an estimate); Command Code records what it charges. Codex records no cost.

// Sums every `"<key>":<number>` in the text. Keys inside message text are JSON-escaped (\"), so they don't match.
function sum(text, re) {
  let total = 0, seen = false;
  for (const m of text.matchAll(re)) {
    const v = Number(m[1]);
    if (Number.isFinite(v)) { total += v; seen = true; }
  }
  return seen ? total : null;
}

// omp: each assistant message's `usage.cost` is `{ input, output, cacheRead, cacheWrite, total }`.
export const ompCost = (text) => sum(text, /"cost":\{[^{}]*"total":(-?[0-9.]+(?:[eE][-+]?\d+)?)/g);

// Command Code: each assistant line's `usage.costUsd`.
export const commandcodeCost = (text) => sum(text, /"costUsd":(-?[0-9.]+(?:[eE][-+]?\d+)?)/g);

// Claude Code keeps its own running total in `{"type":"cost-state","totalCostUSD":...}` records; the last
// one is the session's. null when it priced a model it doesn't know (`hasUnknownModelCost`).
export function claudeCost(text) {
  const at = text.lastIndexOf('"type":"cost-state"');
  if (at < 0) return null;
  const start = text.lastIndexOf("\n", at) + 1;
  const end = text.indexOf("\n", at);
  let rec;
  try { rec = JSON.parse(text.slice(start, end < 0 ? text.length : end)); } catch { return null; }
  if (rec?.hasUnknownModelCost === true) return null;
  return typeof rec?.totalCostUSD === "number" && Number.isFinite(rec.totalCostUSD) ? rec.totalCostUSD : null;
}

// "$8.90", "$123", "<$0.01"; `estimate` (a subscription covers it) prefixes "≈". Nothing for a free session.
export function fmtCost(dollars, estimate = false) {
  if (typeof dollars !== "number" || !(dollars > 0)) return null;
  const s = dollars < 0.01 ? "<$0.01" : dollars >= 100 ? `$${Math.round(dollars)}` : `$${dollars.toFixed(2)}`;
  return estimate ? `≈${s}` : s;
}
