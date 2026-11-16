// The subscriptions pinned in the panel's footer. Pure data and ordering, no host calls.
//
// To add a subscription:
//  1. Live data: add its provider to LABELS in reports.js (limit id -> row label) so `omp usage --json`
//     reports for it are parsed. Cache-only providers (Codex, ...) need nothing here.
//  2. Add one entry below. `card(q)` returns its quota card or null, where q.live / q.cache are
//     Maps of provider id -> { provider, fetched, windows }. `providers` lists the card.provider
//     values that mean "an agent using this subscription is running" (they rank it first).
//     `icon` is a file in ~/.config/herdr-app/icons/ (`tint: true` for one-colour glyphs).

export const SUBSCRIPTIONS = [
  {
    id: "claude-code", name: "Claude Code", icon: "claude", tint: false, providers: ["anthropic", "claude"],
    card: (q) => q.live.get("anthropic") ?? q.cache.get("claude") ?? null,
  },
  {
    id: "codex", name: "Codex", icon: "codex", tint: false, providers: ["codex"],
    card: (q) => q.cache.get("codex") ?? null,
  },
  {
    id: "command-code", name: "Command Code", icon: "command-code", tint: true, providers: ["commandcode"],
    card: (q) => q.live.get("commandcode") ?? null,
  },
];

// Subscriptions that have data now, in registry order.
export function availableSubscriptions(q, registry = SUBSCRIPTIONS) {
  return registry.map((s) => ({ ...s, data: s.card(q) })).filter((s) => s.data?.windows?.length);
}

// What the footer shows. Subscriptions with a running agent come first (registry order within each
// group); at most `limit` are shown unless `open`. -> { shown, hidden, collapsible }.
export function layoutSubscriptions(items, active, open, limit) {
  const live = items.filter((s) => s.providers.some((p) => active.has(p)));
  const rest = items.filter((s) => !live.includes(s));
  const ordered = [...live, ...rest];
  const collapsible = ordered.length > limit;
  const shown = open || !collapsible ? ordered : ordered.slice(0, limit);
  return { shown, hidden: ordered.length - shown.length, collapsible };
}
