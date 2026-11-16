// Quota data for the agents list, drawn as compact rows under an agent: the active model, then its
// subscription limits. Sources:
//  - `omp usage --json` (live): Anthropic 5h / 7d / 7d Fable and Command Code 5h / 7d / credits;
//  - the cache the herdr-agent-usage TUI plugin keeps, for the other providers (e.g. Codex).
// Limits are shown only when the agent's ACTIVE model is covered by that subscription: Claude Code
// and omp read the model from their session transcript, so a gateway or API model (glm, kimi, a
// university cluster, ...) shows its name but no quota.

import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import * as fs from "fs/promises";
import { home, readTextFile, exec } from "herdr";
import { parseReports } from "./reports.js";
import { sessionDirFor, newestTranscript, activeModel, providerOfModel } from "./omp-session.js";
import { claudeProjectDir, lastClaudeModel, claudeProvider } from "./claude-session.js";

const STALE_S = 30 * 60;
const LIVE_EVERY_MS = 60000; // omp caches usage for 5 min itself
const MODEL_EVERY_MS = 30000;
const TAIL_CHARS = 1_000_000; // Claude transcripts grow large; the last model is near the end

const homePath = () => home().replace(/\\/g, "/").replace(/\/+$/, "");

const dataDirs = () => {
  const h = homePath();
  return [
    `${h}/AppData/Local/herdr/plugins/herdr-agent-usage`,
    `${h}/.local/share/herdr/plugins/herdr-agent-usage`,
    `${h}/Library/Application Support/herdr/plugins/herdr-agent-usage`,
    `${h}/.config/herdr/plugins/herdr-agent-usage`,
  ];
};

const WINDOW_LABEL = { five_hour: "5h", weekly: "7d", monthly: "30d" };
const label = (w) => WINDOW_LABEL[w.kind] ?? w.source_label ?? w.kind;
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function windowsOf(list) {
  return (Array.isArray(list) ? list : [])
    .map((w) => ({
      label: label(w),
      used: num(w.used_percent),
      remaining: num(w.remaining_percent) ?? (num(w.used_percent) === null ? null : 100 - w.used_percent),
      resets: num(w.resets_at),
    }))
    .filter((w) => w.used !== null);
}

// One plugin cache file -> cards. omp's own store files are skipped: omp is read live.
function cardsOf(json) {
  if (!json || typeof json.provider !== "string") return [];
  const windows = windowsOf(json.windows);
  return windows.length ? [{ provider: json.provider, fetched: num(json.fetched_at_unix), windows }] : [];
}

async function fetchLive() {
  const r = await exec("omp", ["usage", "--json"], { timeout: 30000 });
  if (r.code !== 0) return null;
  try { return parseReports(JSON.parse(r.stdout)); } catch { return null; }
}

async function loadCache() {
  for (const dir of dataDirs()) {
    let names;
    try { names = await fs.readdir(dir); } catch { continue; }
    const cache = new Map();
    for (const n of names.sort()) {
      if (!n.endsWith(".json") || /\.(original|observation)\.json$/.test(n) || n.includes(".omp-store.") || n === "watch-herdr.json" || n === "icon-attention.json") continue;
      try {
        const text = await readTextFile(`${dir}/${n}`);
        if (text) for (const c of cardsOf(JSON.parse(text))) if (!cache.has(c.provider)) cache.set(c.provider, c);
      } catch { /* half-written file: next tick */ }
    }
    const mode = ((await readTextFile(`${dir}/quota-percent`)) ?? "remaining").trim();
    return { cache, used: mode === "used" };
  }
  return { cache: new Map(), used: false };
}

// The newest transcript in `dir` by last write time, asked of the OS (null if it can't tell).
// Names alone can't decide: an agent started earlier may be the one still being written to.
async function newestByMtime(dir) {
  const r = /^[A-Za-z]:/.test(home())
    ? await exec("powershell", ["-NoProfile", "-Command", `(Get-ChildItem -LiteralPath '${dir.replace(/'/g, "''")}' -Filter *.jsonl -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1).Name`], { timeout: 10000 })
    : await exec("sh", ["-c", 'ls -t "$1"/*.jsonl 2>/dev/null | head -1', "sh", dir], { timeout: 10000 });
  const name = r.stdout.trim().split(/[\\/]/).pop();
  return r.code === 0 && name ? name : null;
}

// The model an omp agent is using in `cwd` ("provider/model"): from the most recently written
// transcript of that folder. Two omp agents in one folder share the answer. null when unknown.
async function ompModelIn(cwd) {
  const dir = sessionDirFor(home(), cwd);
  if (!dir) return null;
  const root = `${homePath()}/.omp/agent/sessions/${dir}`;
  try {
    const file = (await newestByMtime(root)) ?? newestTranscript(await fs.readdir(root));
    if (!file) return null;
    return activeModel((await fs.readFile(`${root}/${file}`, "utf8")).slice(-TAIL_CHARS));
  } catch { return null; }
}

// The model a Claude Code agent is running in `cwd`: last model in the newest transcript of the folder.
async function claudeModelIn(cwd) {
  const dir = claudeProjectDir(home(), cwd);
  if (!dir) return null;
  try {
    const file = await newestByMtime(dir);
    if (!file) return null;
    return lastClaudeModel((await fs.readFile(`${dir}/${file}`, "utf8")).slice(-TAIL_CHARS));
  } catch { return null; }
}

// Which agents have a model to look up: those whose model the app can't tell us.
export const modelKind = (agent) => {
  const k = agent.program?.key ?? agent.app;
  return k === "omp" ? "omp" : k === "claude" || k === "claude-code" ? "claude" : null;
};
const modelKey = (kind, cwd) => `${kind}\u0000${cwd}`;

// -> { live, cache, used, liveAt, models: Map<kind+cwd, {model, at}> }. `prev` is the last result, so
// live readings and transcript lookups are reused between asks; `targets` are { kind, cwd } of the
// omp / Claude Code agents on screen.
export async function loadQuota(prev, targets = []) {
  let live = prev?.live ?? new Map();
  let liveAt = prev?.liveAt ?? 0;
  if (Date.now() - liveAt >= LIVE_EVERY_MS) {
    liveAt = Date.now();
    try { live = (await fetchLive()) ?? live; } catch { /* omp missing or offline: keep the last reading */ }
  }
  const models = new Map();
  for (const { kind, cwd } of targets) {
    const key = modelKey(kind, cwd);
    if (models.has(key)) continue;
    const old = prev?.models?.get(key);
    if (old && Date.now() - old.at < MODEL_EVERY_MS) { models.set(key, old); continue; }
    models.set(key, { model: kind === "omp" ? await ompModelIn(cwd) : await claudeModelIn(cwd), at: Date.now() });
  }
  return { live, liveAt, models, ...(await loadCache()) };
}

// The program key the app reports -> the key the quota sources use.
const ALIAS = { "claude-code": "claude", "command-code": "commandcode", antigravity: "agy" };

// What to show under an agent: { model, card, note } or null. `cwd` is the agent's live folder.
// card is null when the active model isn't covered by a subscription we can read.
export function agentQuota(q, agent, cwd) {
  const kind = modelKind(agent);
  if (kind) {
    const model = q.models.get(modelKey(kind, cwd))?.model ?? null;
    const provider = kind === "claude" ? claudeProvider(model) : providerOfModel(model);
    let card = null;
    if (provider === "anthropic") card = q.live.get("anthropic") ?? q.cache.get("claude") ?? null;
    else if (provider === "commandcode") card = q.live.get("commandcode") ?? null;
    else if (provider === "openai-codex") card = q.cache.get("codex") ?? null;
    if (!model && !card) return null;
    return { model, card, note: card ? null : "no subscription quota" };
  }
  const raw = agent.program?.key ?? agent.app;
  const key = ALIAS[raw] ?? raw;
  const card = q.live.get(key) ?? q.cache.get(key) ?? null;
  return card ? { model: null, card, note: null } : null;
}

function until(unix) {
  const s = unix - Date.now() / 1000;
  if (s <= 0) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h${String(m % 60).padStart(2, "0")}` : `${Math.floor(h / 24)}d`;
}

function gauge(t, pct, color) {
  return div().h(3).flex_1().rounded(2).bg(t.raised).overflow_hidden()
    .child(div().h(3).w(`${Math.max(0, Math.min(100, pct))}%`).rounded(2).bg(color));
}

function line(t, name, shownPct, remaining, tail, dim) {
  // Severity follows headroom whichever way the number is shown.
  let color = t.ansi2;
  if (dim) color = t.dim;
  else if (remaining < 15) color = t.ansi1;
  else if (remaining < 40) color = t.ansi3;
  return h_flex().h(15).flex_none().items_center().gap(6)
    .child(div().w(32).text_size(10.5).text_color(t.dim).child(name))
    .child(gauge(t, shownPct, color))
    .child(div().w(30).text_size(10.5).text_color(dim ? t.dim : t.muted).child(`${Math.round(shownPct)}%`))
    .child(div().w(38).text_size(10).text_color(t.dim).child(tail ?? ""));
}

// A window whose reset has passed: the cached number belongs to the previous period, so show no
// number (the plugin shows N/A too) rather than a wrong one.
function expiredLine(t, name) {
  return h_flex().h(15).flex_none().items_center().gap(6)
    .child(div().w(32).text_size(10.5).text_color(t.dim).child(name))
    .child(gauge(t, 0, t.dim))
    .child(div().w(30).text_size(10.5).text_color(t.dim).child("n/a"))
    .child(div().w(38).text_size(10).text_color(t.dim).child("reset"));
}

function modelLine(t, model, note) {
  return h_flex().h(15).flex_none().items_center().gap(6)
    .child(div().min_w(0).truncate().text_size(10.5).text_color(t.muted).child(model ?? "model unknown"))
    .when(Boolean(note), (e) => e.child(div().flex_none().text_size(10).text_color(t.dim).child(`· ${note}`)));
}

// The block under an agent row, indented to line up under its name. Context % is not shown: the
// cache keeps it per session and an agent row can't be matched to one.
export function quotaBlock(t, info, used) {
  if (!info) return null;
  const now = Date.now() / 1000;
  const rows = [];
  if (info.model !== null || info.note) rows.push(modelLine(t, info.model, info.note));
  const card = info.card;
  if (card) {
    const stale = card.fetched !== null && now - card.fetched > STALE_S;
    const show = (w) => (used ? w.used : w.remaining);
    for (const w of card.windows) {
      if (w.resets !== null && w.resets <= now) rows.push(expiredLine(t, w.label));
      else rows.push(line(t, w.label, show(w), w.remaining, w.tail ?? (w.resets ? until(w.resets) : ""), stale));
    }
  }
  return rows.length ? v_flex().flex_none().pl(33).pr(8).pb(4).gap(1).children(rows) : null;
}
