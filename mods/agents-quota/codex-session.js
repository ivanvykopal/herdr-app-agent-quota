// Which model a Codex agent is running and how full its context is, from its rollout file.
// Pure functions, no host calls: testable with plain `bun`.
//
// Codex keeps `~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl` (by start date, not by folder;
// older ones are later compressed to `.jsonl.zst`, which isn't read). Lines used:
//   session_meta  (first line)  payload.cwd: the folder the session runs in
//   turn_context                payload.model, e.g. `gpt-5.6-terra`
//   event_msg token_count       payload.info.last_token_usage.total_tokens, payload.info.model_context_window,
//                               payload.rate_limits: the plan's limits as of that turn (see codexQuota)

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

// A window's length in minutes -> its row label: 300 -> "5h", 10080 -> "7d", 43200 -> "30d".
function windowLabel(minutes) {
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

// Codex's limit record -> the quota card { provider: "codex", fetched (s), windows }, or null. Rollouts write
// it in snake_case (`used_percent`, `window_minutes`, `resets_at`), the app server in camelCase
// (`usedPercent`, `windowDurationMins`, `resetsAt`). Which window is which depends on the plan (free: one
// 30-day window; others 5h + 7d), so rows are named by length, not by primary/secondary.
function limitsCard(rl, fetched) {
  const windows = [rl.primary, rl.secondary]
    .map((w) => w && { used: w.used_percent ?? w.usedPercent, minutes: w.window_minutes ?? w.windowDurationMins, resets: w.resets_at ?? w.resetsAt })
    .filter((w) => typeof w?.used === "number" && typeof w.minutes === "number" && w.minutes > 0)
    .map((w) => {
      const used = Math.max(0, Math.min(100, w.used));
      return { label: windowLabel(w.minutes), used, remaining: 100 - used, resets: typeof w.resets === "number" ? w.resets : null };
    });
  return windows.length ? { provider: "codex", fetched, windows } : null;
}

// -> the Codex plan's card from the last token_count line that carries `rate_limits`, as of that line's time,
// or null. Codex writes it on every turn (null when signed in with an API key). Only the `codex` limit is
// read; other limit ids are ignored.
export function codexQuota(text) {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!l.includes('"type":"token_count"') || !l.includes('"rate_limits":{')) continue;
    const line = parse(l);
    const rl = line?.payload?.rate_limits;
    if (!rl || (rl.limit_id != null && rl.limit_id !== "codex")) continue;
    const at = Date.parse(line.timestamp);
    return Number.isFinite(at) ? limitsCard(rl, at / 1000) : null;
  }
  return null;
}

// `codex app-server`'s output -> the card from its `account/rateLimits/read` answer (JSON-RPC id 2), read
// `now` (s), or null (not signed in to ChatGPT, an error, no answer).
export function codexLiveQuota(stdout, now) {
  for (const l of stdout.split(/\r?\n/)) {
    if (!l.startsWith("{")) continue;
    const msg = parse(l);
    if (msg?.id !== 2) continue;
    const r = msg.result;
    const rl = r?.rateLimitsByLimitId?.codex ?? (r?.rateLimits?.limitId == null || r.rateLimits.limitId === "codex" ? r?.rateLimits : null);
    return rl ? limitsCard(rl, now) : null;
  }
  return null;
}

// Same folder, as Windows compares paths: separators, trailing slash and case don't matter.
export function sameFolder(a, b) {
  const norm = (p) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return typeof a === "string" && typeof b === "string" && norm(a) === norm(b);
}
