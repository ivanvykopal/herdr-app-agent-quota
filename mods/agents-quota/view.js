// Drawing the quota data (see quota.js for where it comes from): the block under an agent row, the
// blocked reason, the pinned subscriptions footer and the status bar strip. No host calls but `theme`
// values passed in as `t`.

import { div, image, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { availableSubscriptions, orderSubscriptions } from "./subscriptions.js";
import { fmtTokens } from "./context.js";
import { blockedReason, reasonText } from "./blocked.js";

// A reading older than this is drawn dim: the source stopped updating.
const STALE_S = 30 * 60;

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


// "anthropic/claude-opus-5-5 · no subscription quota          ≈$8.90": the session cost sits at the right.
function modelLine(t, model, note, cost) {
  return h_flex().h(15).flex_none().items_center().gap(6)
    .child(div().min_w(0).truncate().text_size(10.5).text_color(t.muted).child(model ?? "model unknown"))
    .when(Boolean(note), (e) => e.child(div().flex_none().text_size(10).text_color(t.dim).child(`· ${note}`)))
    .when(Boolean(cost), (e) => e.child(div().flex_1()).child(div().flex_none().text_size(10.5).text_color(t.muted).child(cost)));
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
  if (info.model !== null || info.note) rows.push(modelLine(t, info.model, info.note, info.cost));
  if (info.context) rows.push(contextLine(t, info.context));
  // Limits under an agent only where nothing else shows them (`limits`): an agent whose model the mod can't
  // read (a program without a transcript reader), or one on another machine (its machine's own logins; the
  // footer and status bar are this computer's). Otherwise the row keeps to model and context.
  const card = info.limits ? info.card : null;
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

// Footer: one row per subscription (see subscriptions.js), styled after Over9k's usage block: icon, name,
// the headline limit's % and its reset time, a chevron. A click opens every limit as a bar; a click on a
// limit pins it as the row's headline (again to unpin). Credits (Cr) show their money, not a percent.
const ROW = 28, LIMIT = 20, FOOTER_MAX = 180;

// Severity by % USED, as Over9k does: red from 80, yellow from 50.
const severity = (t, used) => (used >= 80 ? t.ansi1 : used >= 50 ? t.ansi3 : t.ansi2);

// The limit the collapsed row shows: the pinned one, else the fullest that hasn't reset.
function headline(windows, picked, now) {
  const pct = windows.filter((w) => w.label !== "Cr");
  return pct.find((w) => w.label === picked)
    ?? pct.filter((w) => w.resets === null || w.resets > now).reduce((a, b) => (!a || b.used > a.used ? b : a), null)
    ?? pct[0] ?? null;
}

function limitRow(t, s, w, pinned, ui, now, stale) {
  const expired = w.resets !== null && w.resets <= now;
  const used = expired ? 0 : Math.max(0, Math.min(100, w.used));
  const color = expired || stale ? t.dim : severity(t, used);
  const credits = w.label === "Cr";
  const row = h_flex().id(`limit-${s.id}-${w.label}`).h(LIMIT).items_center().gap(7).text_size(11.5).rounded(4)
    .child(div().w(44).flex_none().truncate().text_color(pinned ? t.accent : t.muted).child(w.label));
  if (credits) {
    return row.child(div().flex_1().flex().justify_end().text_color(t.foreground).child(w.tail ?? ""));
  }
  return row.cursor_pointer().hover((x) => x.bg(t.hover))
    .on_click((_e, cx) => ui.pick(s.id, w.label, cx))
    .tooltip(pinned ? "Unpin as headline number" : "Pin as headline number")
    .child(div().flex_1().h(3).rounded(2).bg(t.raised)
      .child(div().h(3).rounded(2).bg(color).w(`${Math.max(used > 0 ? 3 : 0, used)}%`)))
    .child(div().w(30).flex_none().flex().justify_end().text_color(color).child(expired ? "n/a" : `${Math.round(used)}%`))
    .child(div().w(44).flex_none().flex().justify_end().text_size(10.5).text_color(t.dim)
      .child(w.resets === null ? "" : expired ? "reset" : until(w.resets)));
}

function subscriptionRow(t, s, i, ui, now) {
  const card = s.data;
  const stale = card.fetched !== null && now - card.fetched > STALE_S;
  const open = ui.open.has(s.id);
  const picked = ui.picked[s.id];
  const top = headline(card.windows, picked, now);
  const expired = top && top.resets !== null && top.resets <= now;
  const used = top ? (expired ? 0 : Math.max(0, Math.min(100, top.used))) : 0;
  const resets = card.windows
    .filter((w) => w.resets !== null)
    .map((w) => `${w.label} ${w.resets <= now ? "reset" : `resets in ${until(w.resets)}`}`)
    .join(" · ");
  const file = `icons/${s.icon}.svg`;
  const pic = s.tint ? svg(file).size(12).flex_none().text_color(t.muted) : image(file).w(12).h(12).flex_none();
  const color = expired || stale ? t.dim : severity(t, used);
  const head = h_flex().id(`pinned-${s.id}`).h(ROW).px(4).gap(6).items_center().rounded(6).cursor_pointer()
    .hover((x) => x.bg(t.hover))
    .on_click((_e, cx) => ui.toggle(s.id, cx))
    .tooltip(`${s.name}${resets ? ` · ${resets}` : ""}${stale ? " · data older than 30 min" : ""}`)
    .child(pic)
    .child(div().min_w(0).flex_shrink(1).truncate().text_color(t.muted).child(s.name))
    .child(h_flex().flex_1().min_w(0).justify_end().overflow_hidden()
      .when(Boolean(top) && !open && top.resets !== null && !expired, (el) => el.child(div().min_w(0).truncate().text_size(11).text_color(t.dim).child(until(top.resets)))))
    .when(Boolean(top) && !open, (el) => el.child(div().w(32).flex_none().flex().justify_end().text_color(color)
      .child(expired ? "n/a" : `${Math.round(used)}%`)))
    .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(8).flex_none().text_color(t.dim));
  const limits = [...card.windows].sort((a, b) => (b.label === picked) - (a.label === picked));
  return v_flex().w_full()
    .when(i > 0, (el) => el.border_t(1).border_color(t.border))
    .child(head)
    .when(open, (el) => el.child(v_flex().px(4).pb(4)
      .children(limits.map((w) => limitRow(t, s, w, w.label === picked, ui, now, stale)))));
}

// `ui` = { active: Set of provider ids with a running agent, open: Set of subscription ids,
// picked: { id: window label }, toggle(id, cx), pick(id, label, cx) }. Subscriptions with a running agent
// come first. null when no subscription has data.
export function summaryFooter(t, q, ui) {
  const now = Date.now() / 1000;
  const shown = orderSubscriptions(availableSubscriptions(q), ui.active);
  if (!shown.length) return null;
  // Capped so a long list or several open rows never squeeze the agents list; it scrolls instead.
  return v_flex().flex_none().w_full().border_t(1).border_color(t.border)
    .child(v_flex().id("pinned-list").w_full().max_h(FOOTER_MAX).pt(3).px(10).text_size(12.5).overflow_y_scrollbar()
      .children(shown.map((s, i) => subscriptionRow(t, s, i, ui, now))));
}

// Status bar strip: per selected subscription its icon and one pill per limit, "5h 86% 1h12  7d 81% 3d",
// as % REMAINING (red under 15%, yellow under 40%) and the time to its reset, dimmed. Hover for the full
// reset list. Returns null when nothing is selected or has data. `items` come from availableSubscriptions + pickSubscriptions.
const SHORT = { Fable: "Fbl" };

function pill(t, w, now, stale) {
  const expired = w.resets !== null && w.resets <= now;
  let color = t.ansi2;
  if (expired || stale) color = t.dim;
  else if (w.remaining < 15) color = t.ansi1;
  else if (w.remaining < 40) color = t.ansi3;
  let text = `${Math.round(w.remaining)}%`;
  const credits = w.label === "Cr";
  if (credits && w.tail) text = w.tail; // credits: the money left says more than a percent
  if (expired) text = "n/a";
  return h_flex().flex_none().items_center().gap(3)
    .child(div().text_size(10).text_color(t.dim).child(SHORT[w.label] ?? w.label))
    .child(div().text_size(10.5).font_semibold().text_color(color).child(text))
    .when(!credits && !expired && w.resets !== null, (el) => el.child(div().text_size(10).text_color(t.dim).child(until(w.resets))));
}

export function statusStrip(t, items) {
  if (!items.length) return null;
  const now = Date.now() / 1000;
  return h_flex().flex_none().items_center().gap(14)
    .children(items.map((s) => {
      const card = s.data;
      const stale = card.fetched !== null && now - card.fetched > STALE_S;
      const resets = card.windows
        .filter((w) => w.resets !== null)
        .map((w) => `${w.label} ${w.resets <= now ? "reset" : `resets in ${until(w.resets)}`}`)
        .join(" · ");
      const file = `icons/${s.icon}.svg`;
      const pic = s.tint ? svg(file).size(12).flex_none().text_color(t.muted) : image(file).w(12).h(12).flex_none();
      return h_flex().id(`status-${s.id}`).flex_none().items_center().gap(7)
        .tooltip(`${s.name}${resets ? ` · ${resets}` : ""}${stale ? " · data older than 30 min" : ""}`)
        .child(pic)
        .children(card.windows.map((w) => pill(t, w, now, stale)));
    }));
}
