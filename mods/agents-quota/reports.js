// `omp usage --json` -> one quota card per provider. Pure; no host calls.
//
// A limit's fill is taken from `usedFraction`, which every provider supplies whatever its unit
// (Anthropic: percent of limit; Command Code: dollars or request counts, "unknown" unit).
// Card: { windows: [{ label, used, remaining, resets (s | null), tail? }], fetched (s) }.

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

// provider -> limit id -> row label. Limits not listed here are ignored, not guessed at.
const LABELS = {
  anthropic: { "anthropic:5h": "5h", "anthropic:7d": "7d", "anthropic:7d:fable": "Fable" },
  commandcode: { "5h": "5h", "7d": "7d", credits: "Cr" },
};

function windowOf(provider, limit) {
  const label = LABELS[provider]?.[limit.id];
  const fraction = num(limit.amount?.usedFraction);
  if (!label || fraction === null) return null;
  const used = Math.max(0, Math.min(100, fraction * 100));
  const ms = num(limit.window?.resetsAt);
  const w = { label, used, remaining: 100 - used, resets: ms === null ? null : ms / 1000 };
  // Credits are money: say how much is left.
  if (limit.amount?.unit === "usd" && num(limit.amount.remaining) !== null) w.tail = `$${limit.amount.remaining.toFixed(2)}`;
  return w;
}

export function parseReports(json) {
  const cards = new Map();
  for (const report of Array.isArray(json?.reports) ? json.reports : []) {
    if (!LABELS[report.provider]) continue;
    const windows = (report.limits ?? []).map((l) => windowOf(report.provider, l)).filter(Boolean);
    if (windows.length) cards.set(report.provider, { provider: report.provider, windows, fetched: (num(report.fetchedAt) ?? Date.now()) / 1000 });
  }
  return cards;
}
