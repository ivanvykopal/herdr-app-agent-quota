// Why an agent is blocked, from the agent's own OSC 7501 report (`state=blocked:kind=...:msg=...`).
// Pure functions, no host calls: testable with plain `bun`. Herdr-core never guesses state from the
// screen, so neither do we: if the agent didn't say why, we only say it is waiting.

// kind -> short label. Unknown kinds are shown as sent.
const KIND = { permission: "Permission", question: "Question", auth: "Sign-in" };
const MAX_CHARS = 160;

// One safe line: no escape sequences or control characters, whitespace collapsed, capped.
function oneLine(s) {
  if (typeof s !== "string") return null;
  const t = s
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "") // CSI sequences
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, "") // OSC sequences
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return null;
  return t.length > MAX_CHARS ? `${t.slice(0, MAX_CHARS - 1)}…` : t;
}

// `report` is the agent's status record: { state, kind?, msg?, app? }. -> { kind, msg } for a blocked
// agent (both may be null: it is blocked but didn't say why), or null when it isn't blocked.
export function blockedReason(report) {
  if (!report || typeof report !== "object" || report.state !== "blocked") return null;
  const kind = typeof report.kind === "string" && report.kind ? (KIND[report.kind] ?? oneLine(report.kind)) : null;
  return { kind, msg: oneLine(report.msg) };
}

// The text shown under the agent: "Permission · Run: rm -rf build/ ? Allow this command".
export function reasonText(reason) {
  if (!reason) return null;
  const parts = [reason.kind, reason.msg].filter(Boolean);
  return parts.length ? parts.join(" · ") : "Waiting for you";
}
