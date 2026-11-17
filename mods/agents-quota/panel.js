// What this mod adds to Herdr's `agents` mod, kept out of main.js so main.js stays upstream's file plus a
// few one-line hooks (see RECIPE.md, *Built from*, and sync-upstream.sh): loading the quota data, the
// footer's state, the status bar mode and its subscription picker.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, panes, spaces, run, shared, setShared, openOverlay, window, keys } from "herdr";
import { loadQuota, agentQuota, modelKind } from "./quota.js";
import { summaryFooter, statusStrip } from "./view.js";
import { SUBSCRIPTIONS, availableSubscriptions, pickSubscriptions } from "./subscriptions.js";

// One load for every view of this mod in the runtime: the Agents panel and the status bar block are two
// views, and each loading on its own ran `omp usage`, `codex app-server` and the transcript listing twice.
// Only the RESULT is shared: a view never awaits another view's load (a promise from another view's task
// never woke this one, and a view torn down mid-load never settles its own). A view takes a result younger
// than RELOAD_MS, skips its tick while another view loads, and treats a load older than STUCK_MS as gone.
const RELOAD_MS = 9000, STUCK_MS = 120000;
const loader = { quota: null, at: 0, busySince: 0 };

// In the view's `init`: live limits (omp usage, codex app-server), the plugin's cache, and each agent's
// active model (read from its transcript by folder), reloaded every 10 s into `view.quota`.
export function initQuota(view, cx) {
  view.quota = loader.quota ?? { live: new Map(), cache: new Map(), models: new Map(), used: false };
  view.pinnedOpen = new Set(shared("agentsQuota.open") ?? []); // subscription ids opened in the footer
  view.pinnedPicked = shared("agentsQuota.headline") ?? {}; // subscription id -> pinned headline limit
  view.reloading = false; // a remote machine can answer slowly: never stack reloads on top of each other
  const reloadQuota = (cx) => {
    if (view.reloading) return;
    const now = Date.now();
    if (loader.quota && now - loader.at < RELOAD_MS) {
      if (view.quota !== loader.quota) { view.quota = loader.quota; cx.notify(); }
      return;
    }
    if (now - loader.busySince < STUCK_MS) return; // another view is loading: take its result next tick
    view.reloading = true;
    loader.busySince = now;
    cx.spawn(async (cx) => {
      try {
        const cwds = new Map(panes().map((p) => [p.pane, p.cwd]));
        const targets = agents()
          .map((a) => ({ kind: modelKind(a), cwd: cwds.get(a.pane), address: a.address, status: a.status }))
          .filter((x) => x.kind && x.cwd);
        view.quota = await loadQuota(loader.quota ?? view.quota, targets);
        loader.quota = view.quota;
        loader.at = Date.now();
      } finally {
        view.reloading = false;
        loader.busySince = 0;
      }
      cx.notify();
    });
  };
  cx.timer.every(10000, reloadQuota);
  reloadQuota(cx);
}

// address -> the agent's own status record (state, kind, msg): where a blocked agent says why.
export function reportsOf(all) {
  const recs = new Map(all.map((x) => [x.address, x]));
  return (address) => {
    const r = recs.get(address);
    return r?.report ?? (r?.status && typeof r.status === "object" ? r.status : null);
  };
}

// The pinned subscriptions footer under the agent list. Providers an agent is using right now rank their
// subscriptions first (a remote agent's subscription is another account, so it must not light up the
// footer's local ones).
export function quotaFooter(view, t, list) {
  const active = new Set(list.filter((a) => !a.address.includes("/")).map((a) => agentQuota(view.quota, a)?.card?.provider).filter(Boolean));
  return summaryFooter(t, view.quota, {
    active,
    open: view.pinnedOpen,
    picked: view.pinnedPicked,
    toggle: (id, cx) => {
      if (view.pinnedOpen.has(id)) view.pinnedOpen.delete(id); else view.pinnedOpen.add(id);
      setShared("agentsQuota.open", [...view.pinnedOpen]);
      cx.notify();
    },
    pick: (id, label, cx) => {
      if (view.pinnedPicked[id] === label) delete view.pinnedPicked[id]; else view.pinnedPicked[id] = label;
      setShared("agentsQuota.headline", view.pinnedPicked);
      cx.notify();
    },
  }) ?? div();
}

// The status bar's subscription picker: a check on each one shown in the bar.
export function statusMenu(t) {
  const picked = shared("agentsQuota.statusPinned") ?? null;
  const on = (id) => !picked || picked.includes(id);
  return v_flex().w_full().p(5).bg(t.popover).text_size(12.8)
    .child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).child("Show in status bar"))
    .children(SUBSCRIPTIONS.map((s) => h_flex().id(`pick-${s.id}`).h(31).px(8).gap(9).rounded(7).items_center()
      .text_color(t.foreground).hover((el) => el.bg(t.hover))
      .on_click((_e, cx) => {
        const ids = (picked ?? SUBSCRIPTIONS.map((x) => x.id)).filter((id) => id !== s.id);
        setShared("agentsQuota.statusPinned", on(s.id) ? ids : [...ids, s.id]);
        cx.notify();
      })
      .child(div().flex_1().child(s.name))
      .when(on(s.id), (el) => el.child(svg("mods/workspace-chrome/check.svg").size(14).flex_none().text_color(t.foreground)))));
}

// The palette key as actually bound; without a binding the hint stays useful ("commands").
function hint() {
  const mac = window()?.platform === "macos";
  const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
  const b = keys().find((k) => k.section === "global" && k.action === "app.palette");
  const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
  const key = parts && parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
  return key ? `${key}  commands` : "commands";
}

// The window's bottom bar (layout block with props.status): where it runs, branch, agent count, then the
// selected subscriptions' limits; click them to choose which.
export function statusBar(view, t) {
  const space = spaces().find((s) => s.active);
  const list = agents();
  const needs = list.filter((a) => a.status === "blocked").length;
  const label = (icon, text) => h_flex().gap(6).items_center().child(svg(`mods/workspace-chrome/${icon}.svg`).size(13)).child(text);
  const available = availableSubscriptions(view.quota);
  const strip = statusStrip(t, pickSubscriptions(available, shared("agentsQuota.statusPinned") ?? null));
  const menu = () => openOverlay({ mod: "agents-quota", kind: "popup", width: 240, height: 40 + 31 * SUBSCRIPTIONS.length, props: { statusMenu: true } });
  return h_flex().size_full().px(14).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
    .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
    .when(Boolean(space?.branch), (el) => el.child(label("branch", space.branch)))
    .child(h_flex().gap(6).items_center().child(div().size(6).rounded(3).bg(t.dim)).child(`${list.length} agents`)
      .when(needs > 0, (el) => el.child(div().text_color(t.blocked).child(`· ${needs} needs you`))))
    .when(available.length > 0, (el) => el.child(h_flex().id("status-quota").flex_none().items_center().px(6).h(20).rounded(5).cursor_pointer()
      .hover((x) => x.bg(t.hover)).tooltip("Choose the subscriptions shown here").on_click(menu)
      .child(strip ?? div().text_size(10.5).text_color(t.dim).child("quota"))))
    .child(div().flex_1())
    .child(div().id("palette").text_color(t.dim).on_click(() => run("app.palette")).child(hint()));
}
