// Which model a Command Code agent is running and how full its context is, from its transcript.
// Pure functions, no host calls: testable with plain `bun`.
//
// Command Code keeps `~/.commandcode/projects/<slug of cwd>/<id>.jsonl` (beside `<id>.checkpoints.jsonl`
// and `<id>.meta.json`). The slug lowercases and splits camelCase (`AppData` -> `app-data`,
// `jane.doe` -> `jane-doe`), so a folder is found by its letters and digits, not rebuilt.

const key = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

// The project folder for `cwd` among `names` (the entries of ~/.commandcode/projects), or null.
export function commandcodeProjectDir(names, cwd) {
  if (!cwd) return null;
  const want = key(cwd);
  return want ? (names.find((n) => key(n) === want) ?? null) : null;
}

// The active model: the last top-level `"model"` (assistant messages and `model_change` records both
// carry one, e.g. `recursive/flint-v1.0:free`). Quotes inside message text are escaped, so they don't match.
export function lastCommandcodeModel(text) {
  let found = null;
  for (const m of text.matchAll(/"model":"([^"]+)"/g)) found = m[1];
  return found;
}

// What the last request put in the context window: `usage.inputTokens` (cache reads included), the
// number Command Code's own compaction measures against.
export function commandcodeLastTokens(text) {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"inputTokens"')) continue;
    let entry;
    try { entry = JSON.parse(lines[i]); } catch { continue; }
    const t = entry?.usage?.inputTokens;
    if (entry?.message?.role === "assistant" && typeof t === "number" && t > 0) return t;
  }
  return null;
}
