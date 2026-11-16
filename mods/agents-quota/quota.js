// Quota data for the agents list, drawn as compact rows under an agent: the active model, then its
// subscription limits. Sources:
//  - `omp usage --json` (live): Anthropic 5h / 7d / 7d Fable and Command Code 5h / 7d / credits;
//  - the cache the herdr-agent-usage TUI plugin keeps, for the other providers (e.g. Codex).
// Limits are shown only when the agent's ACTIVE model is covered by that subscription: Claude Code
// and omp read the model from their session transcript, so a gateway or API model (glm, kimi, a
// university cluster, ...) shows its name but no quota.

import { div, image, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import * as fs from "fs/promises";
import { home, readTextFile, exec } from "herdr";
import { parseReports } from "./reports.js";
import { sessionDirFor, newestTranscript, activeModel, providerOfModel } from "./omp-session.js";
import { claudeProjectDir, lastClaudeModel, claudeProvider } from "./claude-session.js";
import { availableSubscriptions, layoutSubscriptions } from "./subscriptions.js";
import { ompLastTokens, claudeLastTokens, parseModelCatalog, catalogWindow, contextOf, fmtTokens } from "./context.js";

const STALE_S = 30 * 60;
const LIVE_EVERY_MS = 60000; // omp caches usage for 5 min itself
const MODEL_EVERY_MS = 30000;
const WINDOWS_EVERY_MS = 600000; // the model catalog (context windows) changes rarely
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

// `omp models --json` -> Map("provider/id" -> context window). ~2 s, so asked rarely.
async function fetchWindows() {
  const r = await exec("omp", ["models", "--json"], { timeout: 30000 });
  if (r.code !== 0) return null;
  try { return parseModelCatalog(JSON.parse(r.stdout)); } catch { return null; }
}

async function loadCache() {
  for (const dir of dataDirs()) {
    let names;
    try { names = await fs.readdir(dir); } catch { continue; }
    const cache = new Map();
    const contexts = new Map(); // Claude Code session id -> context % the plugin measured
    for (const n of names.sort()) {
      if (!n.endsWith(".json") || /\.(original|observation)\.json$/.test(n) || n.includes(".omp-store.") || n === "watch-herdr.json" || n === "icon-attention.json") continue;
      try {
        const text = await readTextFile(`${dir}/${n}`);
        if (!text) continue;
        const json = JSON.parse(text);
        for (const c of cardsOf(json)) if (!cache.has(c.provider)) cache.set(c.provider, c);
        for (const [id, v] of Object.entries(json.session_contexts ?? {})) if (num(v?.used_percent) !== null) contexts.set(id, v.used_percent);
      } catch { /* half-written file: next tick */ }
    }
    const mode = ((await readTextFile(`${dir}/quota-percent`)) ?? "remaining").trim();
    return { cache, contexts, used: mode === "used" };
  }
  return { cache: new Map(), contexts: new Map(), used: false };
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

// What an omp agent is doing in `cwd`, from the most recently written transcript of that folder:
// { model: "provider/model", tokens: last request's context size }. Two omp agents in one folder share
// the answer. null when unknown.
async function ompInfoIn(cwd) {
  const dir = sessionDirFor(home(), cwd);
  if (!dir) return null;
  const root = `${homePath()}/.omp/agent/sessions/${dir}`;
  try {
    const file = (await newestByMtime(root)) ?? newestTranscript(await fs.readdir(root));
    if (!file) return null;
    const text = (await fs.readFile(`${root}/${file}`, "utf8")).slice(-TAIL_CHARS);
    return { model: activeModel(text), tokens: ompLastTokens(text), sessionId: null };
  } catch { return null; }
}

// The same for a Claude Code agent; sessionId is the transcript's name (what the plugin keys by).
async function claudeInfoIn(cwd) {
  const dir = claudeProjectDir(home(), cwd);
  if (!dir) return null;
  try {
    const file = await newestByMtime(dir);
    if (!file) return null;
    const text = (await fs.readFile(`${dir}/${file}`, "utf8")).slice(-TAIL_CHARS);
    return { model: lastClaudeModel(text), tokens: claudeLastTokens(text), sessionId: file.replace(/\.jsonl$/, "") };
  } catch { return null; }
}

// Which agents have a model to look up: those whose model the app can't tell us.
export const modelKind = (agent) => {
  const k = agent.program?.key ?? agent.app;
  if (k === "omp") return "omp";
  return k === "claude" || k === "claude-code" ? "claude" : null;
};
const modelKey = (kind, cwd) => `${kind}\u0000${cwd}`;

// -> { live, cache, contexts, used, liveAt, windows, windowsAt, models: Map<kind+cwd, {model, tokens,
// sessionId, at}> }. `prev` is the last result, so live readings, the model catalog and transcript
// lookups are reused between asks; `targets` are { kind, cwd } of the omp / Claude Code agents on screen.
export async function loadQuota(prev, targets = []) {
  let live = prev?.live ?? new Map();
  let liveAt = prev?.liveAt ?? 0;
  if (Date.now() - liveAt >= LIVE_EVERY_MS) {
    liveAt = Date.now();
    try { live = (await fetchLive()) ?? live; } catch { /* omp missing or offline: keep the last reading */ }
  }
  let windows = prev?.windows ?? new Map();
  let windowsAt = prev?.windowsAt ?? 0;
  if (targets.length && Date.now() - windowsAt >= WINDOWS_EVERY_MS) {
    windowsAt = Date.now();
    try { windows = (await fetchWindows()) ?? windows; } catch { /* keep the last catalog */ }
  }
  const models = new Map();
  for (const { kind, cwd } of targets) {
    const key = modelKey(kind, cwd);
    if (models.has(key)) continue;
    const old = prev?.models?.get(key);
    if (old && Date.now() - old.at < MODEL_EVERY_MS) { models.set(key, old); continue; }
    const info = kind === "omp" ? await ompInfoIn(cwd) : await claudeInfoIn(cwd);
    models.set(key, { model: info?.model ?? null, tokens: info?.tokens ?? null, sessionId: info?.sessionId ?? null, at: Date.now() });
  }
  return { live, liveAt, windows, windowsAt, models, ...(await loadCache()) };
}

// The program key the app reports -> the key the quota sources use.
const ALIAS = { "claude-code": "claude", "command-code": "commandcode", antigravity: "agy" };

// What to show under an agent: { model, card, note, context } or null. `cwd` is the agent's live folder.
// card is null when the active model isn't covered by a subscription we can read. context is
// { pct | null, tokens } for how full the context window is (any model, subscription or not).
export function agentQuota(q, agent, cwd) {
  const kind = modelKind(agent);
  if (kind) {
    const entry = q.models.get(modelKey(kind, cwd));
    const model = entry?.model ?? null;
    const provider = kind === "claude" ? claudeProvider(model) : providerOfModel(model);
    let card = null;
    if (provider === "anthropic") card = q.live.get("anthropic") ?? q.cache.get("claude") ?? null;
    else if (provider === "commandcode") card = q.live.get("commandcode") ?? null;
    else if (provider === "openai-codex") card = q.cache.get("codex") ?? null;
    // Window: omp names models "provider/id", the catalog's keys. Claude Code's `claude-*` ids are
    // Anthropic's; any other model there (a gateway) has no catalog entry we can trust, so only the
    // percent Claude Code itself measured (the plugin's per-session cache) is used.
    const window = kind === "omp" ? catalogWindow(q.windows, model) : catalogWindow(q.windows, provider ? `anthropic/${model}` : null);
    const context = contextOf({ tokens: entry?.tokens ?? null, window, cachedPct: q.contexts.get(entry?.sessionId) ?? null });
    if (!model && !card && !context) return null;
    return { model, card, note: card ? null : "no subscription quota", context };
  }
  const raw = agent.program?.key ?? agent.app;
  const key = ALIAS[raw] ?? raw;
  const card = q.live.get(key) ?? q.cache.get(key) ?? null;
  return card ? { model: null, card, note: null, context: null } : null;
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

// How full the context window is: "ctx  ▬▬▬▬  34%  336k". Always % USED (as agents' own footers show it),
// whatever the quota rows show. Red past 85%, yellow past 60%. Without a percent, just the token count.
function contextLine(t, ctx) {
  if (ctx.pct === null) {
    return h_flex().h(15).flex_none().items_center().gap(6)
      .child(div().w(32).text_size(10.5).text_color(t.dim).child("ctx"))
      .child(div().text_size(10.5).text_color(t.muted).child(`${fmtTokens(ctx.tokens)} tokens`));
  }
  return line(t, "ctx", ctx.pct, 100 - ctx.pct, ctx.tokens ? fmtTokens(ctx.tokens) : "", false);
}

// The block under an agent row, indented to line up under its name: model, context, then quota.
export function quotaBlock(t, info, used) {
  if (!info) return null;
  const now = Date.now() / 1000;
  const rows = [];
  if (info.model !== null || info.note) rows.push(modelLine(t, info.model, info.note));
  if (info.context) rows.push(contextLine(t, info.context));
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

// Footer: pinned subscriptions (see subscriptions.js). More than this many collapse behind "+N more".
export const PINNED_VISIBLE = 3;
const SHORT = { Fable: "Fbl" };

function pill(t, w, used, now, stale) {
  const label = SHORT[w.label] ?? w.label;
  const expired = w.resets !== null && w.resets <= now;
  let color = t.ansi2;
  if (expired || stale) color = t.dim;
  else if (w.remaining < 15) color = t.ansi1;
  else if (w.remaining < 40) color = t.ansi3;
  let text = `${Math.round(used ? w.used : w.remaining)}%`;
  if (w.label === "Cr" && w.tail) text = w.tail; // credits: the money left says more than a percent
  if (expired) text = "n/a";
  return h_flex().flex_none().items_center().gap(3)
    .child(div().text_size(10).text_color(t.dim).child(label))
    .child(div().text_size(10.5).font_semibold().text_color(color).child(text));
}

function subscriptionRow(t, s, used, now) {
  const card = s.data;
  const stale = card.fetched !== null && now - card.fetched > STALE_S;
  const resets = card.windows
    .filter((w) => w.resets !== null)
    .map((w) => `${w.label} ${w.resets <= now ? "reset" : `resets in ${until(w.resets)}`}`)
    .join(" · ");
  const file = `icons/${s.icon}.svg`;
  const pic = s.tint ? svg(file).size(12).flex_none().text_color(t.muted) : image(file).w(12).h(12).flex_none();
  return h_flex().id(`pinned-${s.id}`).h(16).flex_none().items_center().gap(8)
    .tooltip(`${s.name}${resets ? ` · ${resets}` : ""}${stale ? " · data older than 30 min" : ""}`)
    .child(pic)
    .children(card.windows.map((w) => pill(t, w, used, now, stale)));
}

// A tight footer, one line per subscription that has data: "icon  5h 87%  7d 80%  Fbl 78%". Hover for
// resets. Subscriptions with a running agent come first. Past PINNED_VISIBLE the rest hide behind a
// "+N more" row; opened, the list simply grows to show every row (no scrolling, nothing clipped).
// `ui` = { active: Set of provider ids with a running agent, open, toggle(e, cx) }. null when no
// subscription has data.
export function summaryFooter(t, q, ui) {
  const now = Date.now() / 1000;
  const { shown, hidden, collapsible } = layoutSubscriptions(availableSubscriptions(q), ui.active, ui.open, PINNED_VISIBLE);
  if (!shown.length) return null;
  const list = v_flex().id("pinned-list").gap(2)
    .children(shown.map((s) => subscriptionRow(t, s, q.used, now)));
  const toggle = h_flex().id("pinned-toggle").h(14).flex_none().items_center().gap(4)
    .text_size(10).text_color(t.dim).cursor_pointer()
    .hover((e) => e.text_color(t.foreground))
    .on_click(ui.toggle)
    .child(svg(`mods/workspace-chrome/chevron-${ui.open ? "down" : "right"}.svg`).size(10).flex_none())
    .child(div().child(ui.open ? "less" : `+${hidden} more`));
  return v_flex().flex_none().px(16).py(6).gap(2).border_t(1).border_color(t.border)
    .child(list)
    .when(collapsible, (e) => e.child(toggle));
}
