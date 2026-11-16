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
import { home, readTextFile, exec, hc } from "herdr";
import { parseReports } from "./reports.js";
import { sessionDirFor, newestTranscript, activeModel, ompTitle, providerOfModel } from "./omp-session.js";
import { claudeProjectDir, lastClaudeModel, claudeProvider, claudeTitle } from "./claude-session.js";
import { assignTranscripts } from "./assign.js";
import { availableSubscriptions, layoutSubscriptions } from "./subscriptions.js";
import { ompLastTokens, claudeLastTokens, parseModelCatalog, catalogWindow, contextOf, fmtTokens } from "./context.js";
import { blockedReason, reasonText } from "./blocked.js";

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

// `omp usage --json` here, or on `machine`: a remote agent's quota is that machine's own login, never ours.
// The remote shell is non-interactive and often lacks ~/.local/bin, where omp installs itself.
async function fetchLive(machine = null) {
  const r = machine
    ? await exec("sh", ["-c", 'PATH="$HOME/.local/bin:$PATH" omp usage --json'], { on: machine, timeout: 45000 })
    : await exec("omp", ["usage", "--json"], { timeout: 30000 });
  if (r.code !== 0) return null;
  try { return parseReports(JSON.parse(r.stdout)); } catch { return null; }
}

// The machine an agent runs on: its address is `machine/t7` for another machine, `t7` for this one.
const machineOf = (address) => (address.includes("/") ? address.split("/")[0] : null);

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

// Transcripts of a folder, newest write first, with their last write time (ms) as the OS knows it:
// [{ file, mtimeMs }]. Names alone can't say which agent is still writing. Empty if the OS can't tell.
// `machine` null = this computer; else that machine, through the core (assumed Unix).
const MAX_CANDIDATES = 8;
const LIST_SH = 'for f in $(ls -t "$1"/*.jsonl 2>/dev/null | head -n "$2"); do echo "$(basename "$f")|$(( $(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f") * 1000 ))"; done';
async function listTranscripts(dir, machine) {
  let r;
  if (machine) r = await exec("sh", ["-c", LIST_SH, "sh", dir, String(MAX_CANDIDATES)], { on: machine, timeout: 30000 });
  else if (/^[A-Za-z]:/.test(home())) {
    r = await exec("powershell", ["-NoProfile", "-Command", `Get-ChildItem -LiteralPath '${dir.replace(/'/g, "''")}' -Filter *.jsonl -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First ${MAX_CANDIDATES} | ForEach-Object { $_.Name + '|' + [DateTimeOffset]::new($_.LastWriteTime).ToUnixTimeMilliseconds() }`], { timeout: 10000 });
  } else r = await exec("sh", ["-c", LIST_SH, "sh", dir, String(MAX_CANDIDATES)], { timeout: 10000 });
  if (r.code !== 0) return [];
  return r.stdout.split(/\r?\n/)
    .map((l) => l.trim().split("|"))
    .filter((p) => p.length === 2 && p[0].endsWith(".jsonl") && Number.isFinite(Number(p[1])))
    .map(([file, ms]) => ({ file, mtimeMs: Number(ms) }));
}

// A machine's home folder (this computer's, or asked once of the remote and kept). null if it can't be read.
async function homeOf(machine, homes) {
  if (!machine) return homePath();
  if (homes.has(machine)) return homes.get(machine);
  let h = null;
  try {
    const r = await exec("sh", ["-c", 'printf %s "$HOME"'], { on: machine, timeout: 20000 });
    if (r.code === 0 && r.stdout.trim()) h = r.stdout.trim();
  } catch { /* unreachable: try again next time */ }
  if (h) homes.set(machine, h);
  return h;
}

// What differs between omp and Claude Code: where transcripts live (under the machine's `h`ome) and how
// to read one.
const tailOf = (text) => text.slice(-TAIL_CHARS);
const SPECS = {
  omp: {
    root: (cwd, h) => { const d = sessionDirFor(h, cwd); return d ? `${h.replace(/\\/g, "/")}/.omp/agent/sessions/${d}` : null; },
    read: (text) => ({ title: ompTitle(text.slice(0, 4096)), model: activeModel(tailOf(text)), tokens: ompLastTokens(tailOf(text)), sessionId: null }),
  },
  claude: {
    root: (cwd, h) => claudeProjectDir(h, cwd),
    read: (text, file) => ({ title: claudeTitle(tailOf(text)), model: lastClaudeModel(tailOf(text)), tokens: claudeLastTokens(tailOf(text)), sessionId: file.replace(/\.jsonl$/, "") }),
  },
};

// One agent's own facts from the core: when its terminal started, when its status last changed, its live
// title. {} when unknown. (A remote terminal's times are on that machine's clock, as are its transcripts'.)
async function agentMeta(address) {
  try {
    const r = await hc(["get", "--json", address]);
    if (r.code !== 0) return {};
    const j = JSON.parse(r.stdout);
    return { createdMs: num(j.created_ms), statusMs: num(j.status_ms), title: typeof j.title === "string" ? j.title : "" };
  } catch { return {}; }
}

// A remote file's first 4 KiB (the title lives there) and last TAIL_CHARS bytes (the latest messages),
// as one text. `readTextFile` stops at 1 MiB, and transcripts grow past it.
async function readRemote(path, machine) {
  const r = await exec("sh", ["-c", 'head -c 4096 "$1"; printf "\\n"; tail -c "$2" "$1"', "sh", path, String(TAIL_CHARS)], { on: machine, timeout: 60000 });
  if (r.code !== 0) throw new Error(`cannot read ${path} on ${machine}`);
  return r.stdout;
}

// A transcript's facts, read once per (machine, file, last write): { title, model, tokens, sessionId } or null.
async function readTranscript(spec, root, cand, cache, machine) {
  const key = `${machine ?? ""}|${root}/${cand.file}|${cand.mtimeMs}`;
  if (cache.has(key)) return cache.get(key);
  let info = null;
  try {
    const path = `${root}/${cand.file}`;
    info = spec.read(machine ? await readRemote(path, machine) : await fs.readFile(path, "utf8"), cand.file);
  } catch { /* unreadable: no info */ }
  cache.set(key, info);
  if (cache.size > 40) cache.delete(cache.keys().next().value); // oldest first
  return info;
}

// Works out which transcript each agent of one group (same machine, kind and folder) is writing, and reads
// its model and context. -> Map(address -> { model, tokens, sessionId }). Agents with no transcript of
// their own get nothing rather than another agent's.
async function resolveGroup(kind, cwd, machine, members, cache, homes) {
  const out = new Map(members.map((m) => [m.address, { model: null, tokens: null, sessionId: null }]));
  const spec = SPECS[kind];
  const h = await homeOf(machine, homes);
  const root = h ? spec.root(cwd, h) : null;
  if (!root) return out;
  const metas = [];
  for (const m of members) metas.push(await agentMeta(m.address));
  let cands = [];
  try { cands = await listTranscripts(root, machine); } catch { /* fall through to the name order */ }
  if (!cands.length && kind === "omp" && !machine) { // no file times: omp names sort by start time
    try { const f = newestTranscript(await fs.readdir(root)); if (f) cands = [{ file: f, mtimeMs: Date.now() }]; } catch { /* none */ }
  }
  const infos = new Map();
  for (const c of cands) infos.set(c.file, await readTranscript(spec, root, c, cache, machine));
  const assigned = assignTranscripts(
    members.map((m, i) => ({ id: m.address, working: m.status === "working", statusMs: metas[i].statusMs ?? null, createdMs: metas[i].createdMs ?? null, paneTitle: metas[i].title ?? "" })),
    cands.map((c) => ({ file: c.file, mtimeMs: c.mtimeMs, title: infos.get(c.file)?.title ?? "" })),
    Date.now(),
  );
  for (const m of members) {
    const c = assigned.get(m.address);
    const info = c ? infos.get(c.file) : null;
    if (info) out.set(m.address, { model: info.model, tokens: info.tokens, sessionId: info.sessionId });
  }
  return out;
}

// Which agents have a model to look up: those whose model the app can't tell us.
export const modelKind = (agent) => {
  const k = agent.program?.key ?? agent.app;
  if (k === "omp") return "omp";
  return k === "claude" || k === "claude-code" ? "claude" : null;
};

// -> { live, liveRemote: Map<machine, { cards, at }>, cache, contexts, used, liveAt, windows, windowsAt,
// fileCache, homes, models: Map<agent address, {model, tokens, sessionId, status, at}> }. `prev` is the last
// result, so live readings, the model catalog and transcript lookups are reused between asks; `targets` are
// { kind, cwd, address, status } of the omp / Claude Code agents on screen, on this computer or another
// machine (address `machine/t7`). Agents sharing a folder are told apart (see assign.js).
export async function loadQuota(prev, targets = []) {
  let live = prev?.live ?? new Map();
  let liveAt = prev?.liveAt ?? 0;
  if (Date.now() - liveAt >= LIVE_EVERY_MS) {
    liveAt = Date.now();
    try { live = (await fetchLive()) ?? live; } catch { /* omp missing or offline: keep the last reading */ }
  }
  // Each machine with an agent on screen is asked about its own logins (kept when it fails).
  const liveRemote = new Map(prev?.liveRemote ?? []);
  for (const machine of new Set(targets.map((t) => machineOf(t.address)).filter(Boolean))) {
    const old = liveRemote.get(machine);
    if (old && Date.now() - old.at < LIVE_EVERY_MS) continue;
    let cards = old?.cards ?? new Map();
    try { cards = (await fetchLive(machine)) ?? cards; } catch { /* unreachable: keep the last reading */ }
    liveRemote.set(machine, { cards, at: Date.now() });
  }
  let windows = prev?.windows ?? new Map();
  let windowsAt = prev?.windowsAt ?? 0;
  if (targets.length && Date.now() - windowsAt >= WINDOWS_EVERY_MS) {
    windowsAt = Date.now();
    try { windows = (await fetchWindows()) ?? windows; } catch { /* keep the last catalog */ }
  }
  const fileCache = prev?.fileCache ?? new Map();
  const homes = prev?.homes ?? new Map();
  const groups = new Map();
  for (const t of targets) {
    const key = `${machineOf(t.address) ?? ""}\u0000${t.kind}\u0000${t.cwd}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  const models = new Map();
  for (const members of groups.values()) {
    // Redo a group when any member is new, changed status (its transcript just got written) or aged out.
    const fresh = members.every((m) => {
      const old = prev?.models?.get(m.address);
      return old && old.status === m.status && Date.now() - old.at < MODEL_EVERY_MS;
    });
    if (fresh) { for (const m of members) models.set(m.address, prev.models.get(m.address)); continue; }
    const resolved = await resolveGroup(members[0].kind, members[0].cwd, machineOf(members[0].address), members, fileCache, homes);
    for (const m of members) models.set(m.address, { ...resolved.get(m.address), status: m.status, at: Date.now() });
  }
  return { live, liveRemote, liveAt, windows, windowsAt, fileCache, homes, models, ...(await loadCache()) };
}

// The program key the app reports -> the key the quota sources use.
const ALIAS = { "claude-code": "claude", "command-code": "commandcode", antigravity: "agy" };

// What to show under an agent: { model, card, note, context } or null. Each agent has its own transcript
// (see assign.js). card is null when the active model isn't covered by a subscription we can read. context
// is { pct | null, tokens } for how full the context window is (any model, subscription or not).
// A remote agent never borrows this computer's numbers: its quota is its machine's own `omp usage`, and the
// plugin's local cache (our accounts) is not consulted.
export function agentQuota(q, agent) {
  const machine = machineOf(agent.address);
  const live = machine ? (q.liveRemote?.get(machine)?.cards ?? new Map()) : q.live;
  const cache = machine ? new Map() : q.cache;
  const kind = modelKind(agent);
  if (kind) {
    const entry = q.models.get(agent.address);
    const model = entry?.model ?? null;
    const provider = kind === "claude" ? claudeProvider(model) : providerOfModel(model);
    let card = null;
    if (provider === "anthropic") card = live.get("anthropic") ?? cache.get("claude") ?? null;
    else if (provider === "commandcode") card = live.get("commandcode") ?? null;
    else if (provider === "openai-codex") card = cache.get("codex") ?? null;
    // Window: omp names models "provider/id", the catalog's keys. Claude Code's `claude-*` ids are
    // Anthropic's; any other model there (a gateway) has no catalog entry we can trust, so only the
    // percent Claude Code itself measured (the plugin's per-session cache) is used.
    const window = kind === "omp" ? catalogWindow(q.windows, model) : catalogWindow(q.windows, provider ? `anthropic/${model}` : null);
    const context = contextOf({ tokens: entry?.tokens ?? null, window, cachedPct: machine ? null : (q.contexts.get(entry?.sessionId) ?? null) });
    if (!model && !card && !context) return null;
    let note = null;
    if (!card) note = machine && provider ? `quota not read on ${machine}` : "no subscription quota";
    return { model, card, note, context };
  }
  if (machine) return null;
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

// Why an agent is blocked, under its row: "Permission · Run: rm -rf build/ ?" in the blocked colour, up to two
// lines (clipped, nothing scrolls), full text on hover. `report` is the agent's own status record; null
// unless it is blocked. `key` makes the hover target unique; `pl` lines the text up under the name.
export function blockedRow(t, report, key, pl = 33) {
  const text = reasonText(blockedReason(report));
  if (!text) return null;
  return div().id(`why-${key}`).flex_none().pl(pl).pr(8).pb(4).max_h(32).overflow_hidden()
    .text_size(10.5).text_color(t.blocked).tooltip(text).child(text);
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
