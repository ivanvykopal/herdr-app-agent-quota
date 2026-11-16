// Context-window use of an agent, from its session transcript. Pure functions, no host calls: testable
// with plain `bun`.
//
// tokens = what the last request put in the context window; window = the model's size. Claude Code's own
// status line uses the same sum: input + cache read + cache creation tokens of the last assistant message.

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

// Walks the transcript from the end and returns the first assistant line `pick` can read tokens from.
function lastTokens(text, marker, pick) {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes(marker)) continue;
    let entry;
    try { entry = JSON.parse(lines[i]); } catch { continue; }
    const tokens = pick(entry);
    if (tokens > 0) return tokens;
  }
  return null;
}

// omp: the assistant message carries `contextSnapshot.promptTokens` (what it sent), else usage totals.
export function ompLastTokens(text) {
  return lastTokens(text, '"role":"assistant"', (e) => {
    const m = e.message;
    if (m?.role !== "assistant") return 0;
    const snapshot = num(m.contextSnapshot?.promptTokens);
    if (snapshot > 0) return snapshot;
    const u = m.usage ?? {};
    return num(u.input) + num(u.cacheRead) + num(u.cacheWrite);
  });
}

// Claude Code: `{ "type": "assistant", "message": { "model", "usage": {...} } }`. `<synthetic>` messages
// (interrupts and the like) are Claude Code's own, with no real usage.
export function claudeLastTokens(text) {
  return lastTokens(text, '"type":"assistant"', (e) => {
    const m = e.message;
    if (e.type !== "assistant" || !m?.usage || m.model === "<synthetic>") return 0;
    return num(m.usage.input_tokens) + num(m.usage.cache_read_input_tokens) + num(m.usage.cache_creation_input_tokens);
  });
}

// `omp models --json` -> Map("provider/id" -> contextWindow tokens).
export function parseModelCatalog(json) {
  const windows = new Map();
  for (const m of Array.isArray(json?.models) ? json.models : []) {
    if (typeof m?.provider === "string" && typeof m?.id === "string" && num(m.contextWindow) > 0) windows.set(`${m.provider}/${m.id}`, m.contextWindow);
  }
  return windows;
}

// The window of "provider/id", also trying Claude's dated ids (claude-haiku-4-5-20251001 -> claude-haiku-4-5).
export function catalogWindow(windows, model) {
  if (!model) return null;
  return windows.get(model) ?? windows.get(model.replace(/-\d{8}$/, "")) ?? null;
}

// -> { pct (0-100 | null), tokens } or null when there is nothing to say. `cachedPct` is a percent
// someone else measured (the plugin's per-session Claude cache), used only when the window is unknown.
export function contextOf({ tokens, window, cachedPct }) {
  if (window && tokens) return { pct: Math.min(100, (tokens / window) * 100), tokens };
  if (cachedPct !== null && cachedPct !== undefined) return { pct: cachedPct, tokens: tokens ?? null };
  return tokens ? { pct: null, tokens } : null;
}

export function fmtTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}
