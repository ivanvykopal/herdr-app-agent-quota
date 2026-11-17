// Which model a Codex agent is running and how full its context is, from its rollout file.
// Pure functions, no host calls: testable with plain `bun`.
//
// Codex keeps `~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl` (by start date, not by folder;
// older ones are later compressed to `.jsonl.zst`, which isn't read). Lines used:
//   session_meta  (first line)  payload.cwd: the folder the session runs in
//   turn_context                payload.model, e.g. `gpt-5.6-terra`
//   event_msg token_count       payload.info.last_token_usage.total_tokens, payload.info.model_context_window

// Codex's own footer leaves a fixed baseline (system prompt, tools) out of the percent:
// used = (tokens - 12000) / (window - 12000). Using the same keeps the gauge equal to Codex's `Context N% used`.
const BASELINE_TOKENS = 12000;

const parse = (line) => { try { return JSON.parse(line); } catch { return null; } };

// The session's folder, from the first line. null if the text doesn't start with session_meta.
export function codexCwd(text) {
  const end = text.indexOf("\n");
  const first = parse(end < 0 ? text : text.slice(0, end));
  return first?.type === "session_meta" && typeof first.payload?.cwd === "string" ? first.payload.cwd : null;
}

// -> { model, tokens, pct } from the last turn_context and token_count lines (nulls when absent).
export function codexState(text) {
  let model = null, tokens = null, pct = null;
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0 && (model === null || tokens === null); i--) {
    const l = lines[i];
    if (model === null && l.includes('"type":"turn_context"')) {
      const m = parse(l)?.payload?.model;
      if (typeof m === "string" && m) model = m;
    } else if (tokens === null && l.includes('"type":"token_count"')) {
      const info = parse(l)?.payload?.info;
      const t = info?.last_token_usage?.total_tokens;
      const w = info?.model_context_window;
      if (typeof t !== "number" || t <= 0) continue;
      tokens = t;
      if (typeof w === "number" && w > BASELINE_TOKENS) pct = Math.min(100, Math.max(0, ((t - BASELINE_TOKENS) / (w - BASELINE_TOKENS)) * 100));
    }
  }
  return { model, tokens, pct };
}

// Same folder, as Windows compares paths: separators, trailing slash and case don't matter.
export function sameFolder(a, b) {
  const norm = (p) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return typeof a === "string" && typeof b === "string" && norm(a) === norm(b);
}
