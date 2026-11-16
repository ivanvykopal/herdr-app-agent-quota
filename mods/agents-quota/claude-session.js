// Which model a Claude Code agent is running, from its transcript, and whether that model is
// covered by an Anthropic subscription. Pure functions, no host calls: testable with plain `bun`.

// Claude Code keeps `~/.claude/projects/<cwd with every non-alphanumeric character -> "-">/<id>.jsonl`.
export function claudeProjectDir(home, cwd) {
  if (!cwd) return null;
  return `${home.replace(/\\/g, "/").replace(/\/+$/, "")}/.claude/projects/${cwd.replace(/[^A-Za-z0-9]/g, "-")}`;
}

// The model on the transcript's last assistant message. `<synthetic>` is Claude Code's own marker
// for messages it wrote itself (e.g. interrupts), not a model.
export function lastClaudeModel(text) {
  let found = null;
  for (const m of text.matchAll(/"model":"([^"]+)"/g)) if (m[1] !== "<synthetic>") found = m[1];
  return found;
}

// A direct session reports Anthropic's own ids (`claude-*`). Anything else (glm-5.3, kimi-k3, ...) is a
// gateway or API endpoint, which has its own billing and no Anthropic subscription window.
export const claudeProvider = (model) => (model && model.startsWith("claude-") ? "anthropic" : null);
