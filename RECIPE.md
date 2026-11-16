# Agent quota

The Agents list in the Herdr desktop app, with each agent's **active model** and, if that model has a
subscription, its **quota gauges** right under the agent's row. A Claude Code agent on `claude-sonnet-5-5`
shows 5h, 7d and Fable weekly limits; an omp agent on `lm-studio/glm-5.3` shows only the model and
`no subscription quota`.

![Agent quota](preview.png)

## What you see

The shipped Agents panel (header "Agents", sort button, groups such as Working / Idle / Needs you, one
30px row per agent with icon, name, status). Under a row, when something is known, a block indented 33px
(to line up under the name), 8px right padding, 4px bottom padding, 1px between lines, each line 15px tall:

1. **Model line**, always when a model is known: the model id (`anthropic/claude-sonnet-5-5`,
   `lm-studio/glm-5.3`) in 10.5px `muted`, truncated; for a model with no subscription, a second piece
   `· no subscription quota` in 10px `dim`.
2. **One gauge line per limit**, only for subscription models: a 32px label (`5h`, `7d`, `Fable`, `30d`,
   `Cr`) in 10.5px `dim`; a 3px-tall rounded track (`raised`) filled to the shown percent; a 30px percent
   in 10.5px `muted`; a 38px tail in 10px `dim` (time to reset like `1h08`, `2d`; for `Cr` the dollars
   left like `$10.00`).
3. Nothing at all when the model isn't known yet or the agent has no folder under the home folder.
4. **Pinned footer**, below the agent list and above the sidebar footer, hidden in the narrow rail: a 1px
   `border` top line, 16px side padding, 6px vertical, 2px between lines. One 16px line per subscription
   that has data: a 12px provider icon, then `label value` pills 8px apart, label 10px `dim`, value 10.5px
   semibold coloured like the gauges (`dim` when the reading is older than 30 min or reset). Claude Code:
   `5h 87%  7d 80%  Fbl 78%` (Fable shortened to `Fbl`); Codex: `30d 40%`. Hover shows a tooltip with the
   provider name and reset times.

Fill colour follows what is left, whichever number is shown: `ansi1` (red) under 15% left, `ansi3`
(yellow) under 40%, `ansi2` (green) otherwise, `dim` when the reading is older than 30 minutes.

## How it behaves

- Agent statuses (working, blocked, done, idle) look and act exactly as in the shipped `agents` mod; the
  quota block follows its row, and folding an agent with sub-agents keeps the block, hides the sub-rows.
- A limit whose reset time has passed shows a `dim` empty track, `n/a` and `reset` instead of a number.
- The percentage is remaining quota by default; the herdr-agent-usage plugin's `quota-percent` file set
  to `used` flips it.
- No clicks or keys of its own. The narrow rail (sidebar < 160px) shows no quota.
- Data updates: the mod re-reads every 10 s; `omp usage --json` at most once a minute; each agent's
  model at most every 30 s.

## Built from

A clone of the shipped `agents` mod (`herdr-app do mod.clone '{"name":"agents","as":"agents-quota"}'`,
version 0.1.16) with `mod.json` `{"place":"none","title":"Agents"}`, plus five modules:

- `quota.js`: `loadQuota(prev, targets)` returns `{ live, cache, used, liveAt, models }`;
  `agentQuota(q, agent, cwd)` returns `{ model, card, note }` or null; `quotaBlock(t, info, used)` draws it;
  `modelKind(agent)` is `"omp"`, `"claude"` or null.
- `reports.js`: `parseReports(json)` turns `omp usage --json` into one card per provider. The fill uses
  each limit's `usedFraction` (Anthropic reports percent, Command Code an "unknown" unit). Row labels:
  anthropic `5h`, `7d`, `7d:fable` -> `Fable`; commandcode `5h`, `7d`, `credits` -> `Cr` (+ dollars left).
- `omp-session.js`: omp transcripts live in `~/.omp/agent/sessions/<cwd minus home, separators to "-">/`
  (home itself is `-`). `activeModel(text)` scans lines from the end and returns the first of an assistant
  message (`message.provider` + `message.model` -> `provider/model`) or a `model_change` entry (`model`).
- `claude-session.js`: transcripts in `~/.claude/projects/<cwd with every non-alphanumeric -> "-">/`;
  `lastClaudeModel(text)` is the last `"model":"..."` that isn't `<synthetic>`; `claudeProvider(model)` is
  `anthropic` only for ids starting `claude-`.
- Patch to `main.js`: import from `./quota.js`; in `init`, `this.quota` plus a `cx.timer.every(10000)` that
  builds `targets` from `agents()` and `panes()` (cwd by `a.pane`) and calls `loadQuota`; in `render`,
  `cwdOf = new Map(panes().map(p => [p.pane, p.cwd]))`; in `withKids`, `quotaBlock(t, agentQuota(...),
  this.quota.used)` inserted after the row (not when collapsed).

Which quota an active model gets: `claude-*` (Claude Code) or `anthropic/*` (omp) -> live Anthropic card;
`commandcode/*` (omp) or the `commandcode` CLI -> live Command Code card; `openai-codex/*` -> Codex from the
herdr-agent-usage plugin cache; everything else -> model name + note.

Reads and runs (tell the person before installing): `exec("omp", ["usage","--json"])`;
`exec("powershell", ["-NoProfile","-Command", "(Get-ChildItem -LiteralPath '<dir>' -Filter *.jsonl | Sort-Object
LastWriteTime -Descending | Select-Object -First 1).Name"])` on Windows, `sh -c 'ls -t "$1"/*.jsonl | head -1'`
elsewhere; `fs/promises` `readdir`/`readFile` of transcripts and of
`<home>/AppData/Local/herdr/plugins/herdr-agent-usage/` (Linux/macOS equivalents are tried);
`readTextFile` of that folder's JSON and `quota-percent`. No network of its own, no writes. Herdr API used:
`agents`, `panes`, `theme`, `home`, `exec`, `readTextFile`, `cx.timer.every`, `cx.spawn`.

## Watch out

- Transcript files are picked by last write time, and two agents in one folder share an answer; names
  alone were wrong (an older session can be the active one).
- omp assistant messages carry the real provider and model even when no `model_change` was ever written
  (a model from config), so don't rely on `model_change` alone.
- Do not show context %: Claude and Codex keep it per session and a row can't be matched to a session.
- The Claude and Codex numbers don't depend on which agent row it is; they are per provider.
- `readTextFile` caps at 1 MiB; transcripts are read with `fs.readFile` and only the last 1,000,000
  characters are scanned.
- The mod replaces the whole Agents panel; a layout must reference `agents-quota`. Shipped layouts are
  read-only, so clone one first. The clone is never updated by Herdr.
- `herdr-app check` really runs `omp usage` (a warning says so).
- Dash-prefixed folder names (`-Desktop-...`) need `./` or `--` in shell commands when debugging.

## Done when

- `herdr-app check mods/agents-quota` passes.
- A Claude Code agent on a `claude-*` model shows its id, then `5h`, `7d`, `Fable` lines whose percents
  equal `100 - used` from `omp usage --json` (`anthropic:5h`, `anthropic:7d`, `anthropic:7d:fable`).
- The same agent on a `glm-*` / `kimi-*` model shows the model and `· no subscription quota`, no gauges.
- An omp agent on `lm-studio/glm-5.3` shows the same note; on `commandcode/...` it shows `5h`, `7d` and
  `Cr` with dollars left.
- With two transcripts in one folder, the model shown is the one in the most recently written file.
- Collapsing the sidebar to the rail hides all quota lines; expanding brings them back.
- With no agent running, the pinned footer still shows the Claude Code and Codex lines from live /
  cached data, and hovering a line shows the reset times.
