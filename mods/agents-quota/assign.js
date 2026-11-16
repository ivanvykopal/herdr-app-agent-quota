// Which transcript belongs to which agent when several agents run in one folder. Pure functions, no host
// calls: testable with plain `bun`.
//
// An agent is { id, working, statusMs, createdMs, paneTitle } (times in ms; statusMs = when its status last
// changed, createdMs = when its terminal started). A candidate is { file, mtimeMs, title }.
//
// 1. A transcript can't belong to a terminal that started after the transcript was last written.
// 2. Title: the agent's terminal title contains the session's title ("π ⠏ 📊 QUOTA: Add ..." contains
//    "📊 QUOTA: Add ..."). A match is a sure thing, so it goes first.
// 3. Time, for the rest: a working agent is writing now; an idle or done one wrote its last message when it
//    went idle (statusMs). Closest pairs first, each transcript used once.
// An agent left without a transcript gets none (better than another agent's answer).

// Letters and digits only, lower case: drops the agent's glyph, spinner frames, emoji and spacing, so the
// title the agent keeps and the one in its terminal title compare equal.
export const normTitle = (s) => (typeof s === "string" ? s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "") : "");

const MIN_TITLE_CHARS = 6; // shorter titles match too much by accident

function titleMatches(paneTitle, candidateTitle) {
  const t = normTitle(candidateTitle);
  return t.length >= MIN_TITLE_CHARS && normTitle(paneTitle).includes(t);
}

export function assignTranscripts(agents, candidates, now) {
  const result = new Map(agents.map((a) => [a.id, null]));
  const used = new Set();
  const eligible = (a, c) => !used.has(c.file) && (a.createdMs == null || c.mtimeMs >= a.createdMs);

  // 2. titles
  for (const a of agents) {
    const hits = candidates.filter((c) => eligible(a, c) && titleMatches(a.paneTitle, c.title));
    if (!hits.length) continue;
    const best = hits.reduce((x, y) => (y.mtimeMs > x.mtimeMs ? y : x));
    result.set(a.id, best);
    used.add(best.file);
  }

  // 3. time, closest pairs first
  const pairs = [];
  for (const a of agents) {
    if (result.get(a.id)) continue;
    const ref = a.working || a.statusMs == null ? now : a.statusMs;
    for (const c of candidates) if (eligible(a, c)) pairs.push({ a, c, d: Math.abs(c.mtimeMs - ref) });
  }
  pairs.sort((x, y) => x.d - y.d);
  for (const { a, c } of pairs) {
    if (result.get(a.id) || used.has(c.file)) continue;
    result.set(a.id, c);
    used.add(c.file);
  }
  return result;
}
