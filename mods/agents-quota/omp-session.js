// Which provider an omp agent is using, from its session transcript. Pure functions, no host calls,
// so they can be tested with plain `bun`.

// omp keeps `<agent dir>/sessions/<cwd, home stripped, separators -> "-">/<time>_<id>.jsonl`:
// C:\Users\me\Desktop\Projects -> "-Desktop-Projects", the home folder itself -> "-". Outside the home folder
// the name is encoded differently ("--C--tmp--"); not handled, so it returns null.
export function sessionDirFor(home, cwd) {
  const h = home.replace(/\\/g, "/").replace(/\/+$/, "");
  const c = (cwd ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (!c) return null;
  if (c.toLowerCase() !== h.toLowerCase() && !c.toLowerCase().startsWith(`${h.toLowerCase()}/`)) return null;
  return `-${c.slice(h.length).split("/").filter(Boolean).join("-")}`;
}

// File names start with a UTC timestamp, so the last one sorted is the newest session. Only top-level
// transcripts count: a sub-agent's transcript lives in a folder named after the session.
export function newestTranscript(names) {
  const files = names.filter((n) => n.endsWith(".jsonl")).sort();
  return files.length ? files[files.length - 1] : null;
}

// The model in use, "provider/model": whichever comes last in the transcript, an assistant message
// (it names the provider and model that really served it, even when no model_change was ever recorded,
// e.g. a model taken from config) or a model_change (a switch the user hasn't sent a message after yet).
export function activeModel(text) {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const change = line.includes('"type":"model_change"');
    if (!change && !line.includes('"role":"assistant"')) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (change && typeof entry.model === "string") return entry.model;
    const m = entry.message;
    if (m?.role === "assistant" && typeof m.provider === "string" && typeof m.model === "string") return `${m.provider}/${m.model}`;
  }
  return null;
}

// The session title omp keeps in the transcript's first line (`{"type":"title","title":"..."}`, rewritten in
// place as it changes; empty until one is generated). Looks at the head only. null when there is none.
export function ompTitle(head) {
  const line = head.split("\n", 1)[0];
  if (!line.includes('"type":"title"')) return null;
  try {
    const t = JSON.parse(line).title;
    return typeof t === "string" && t ? t : null;
  } catch { return null; }
}

export const providerOfModel = (model) => (model && model.includes("/") ? model.split("/")[0] : null);
