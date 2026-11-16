# herdr-app-agent-quota

A [Herdr desktop app](https://github.com/herdrdev/herdr-app) **mod** that shows each agent's active
model and, when that model has a subscription, its quota (5h / 7d / Fable weekly / credits) directly
under the agent in the Agents list.

![Agents with their model and quota, and the pinned subscriptions footer](preview.png)

*Per-agent model and quota (top: a subscription model with limits, an API model with none) and the pinned
subscriptions footer (bottom: Claude Code, Codex, Command Code). The empty space between them is cropped.*

- **Follows the active model.** A Claude Code or omp agent running a subscription model shows live
  limits. The same agent on an API or gateway model (a cluster, LM Studio, `glm-*`, `kimi-*`, ...) shows
  the model name and `no subscription quota`, because Anthropic's limits don't apply to it.
- **Live numbers** come from [`omp usage --json`](https://github.com/can1357/oh-my-pi): Anthropic 5h, 7d
  and the separate 7d **Fable** limit, and Command Code 5h, 7d and credit balance.
- Gauges turn red under 15% left and yellow under 40%; a window whose reset has passed shows `n/a`.
- **Pinned subscriptions footer:** a tight strip at the bottom of the panel always shows your Claude Code
  (`5h`, `7d`, `Fbl`), Codex (`30d`) and Command Code (`5h`, `7d`, credits `Cr $…`) limits, whether or not
  an agent is running. Hover a line for reset times. Subscriptions with a running agent come first. With
  more than 3, the rest collapse behind a `+N more` row that expands the list (no scrolling).
- **Adding a subscription** is data, not UI code: add its provider to `LABELS` in `reports.js` (live data
  from `omp usage --json`; skip for cache-only providers) and one entry to `SUBSCRIPTIONS` in
  `subscriptions.js` (name, icon, which card to use). It then appears in the footer by itself.

| Active model | Shown |
|---|---|
| Claude Code, `claude-*` | Anthropic 5h, 7d, Fable (live) |
| Claude Code, anything else | model name, `no subscription quota` |
| omp, `anthropic/...` | Anthropic limits (live) |
| omp, `commandcode/...`; the `commandcode` CLI | Command Code 5h, 7d, credits `Cr` (live) |
| omp, `openai-codex/...`; Codex | Codex, from the optional plugin cache (see below) |
| omp, any other provider | model name, `no subscription quota` |
| model not known yet, or a folder outside your home | nothing |

## Requirements

- Herdr desktop app (built against mod API / `agents` mod **v0.1.16**).
- `omp` on your `PATH` for live Anthropic / Command Code limits. Without it those rows stay empty.
- Optional: the [herdr-agent-usage](https://github.com/levi-qiao/herdr-agent-usage) plugin, whose cache
  is the only source for Codex (and other providers it supports). That cache only updates while a Herdr
  TUI session is running, so those gauges turn gray after 30 minutes.

## Install

```sh
git clone https://github.com/ivanvykopal/herdr-app-agent-quota
cd herdr-app-agent-quota
./install.sh            # macOS / Linux
./install.ps1           # Windows (PowerShell)
```

This copies `mods/agents-quota/` to `~/.config/herdr-app/mods/` (or `$HERDR_APP_HOME`) and runs
`herdr-app check`. Or copy that folder by hand.

The mod **replaces the Agents panel**, so a layout has to use it. Herdr's shipped layouts are read-only,
so clone one and point its agents block at the mod:

```sh
herdr-app do layout.clone '{"name":"main","as":"main-quota"}'
```

then in `~/.config/herdr-app/layouts/main-quota.json` set the agents block to
`"content": { "mod": "agents-quota" }`. `ctrl-shift-l` switches layouts.

## What it runs and reads (review before installing)

Mods are trusted code. This one:

- runs `omp usage --json` once a minute (omp contacts the Anthropic / Command Code usage endpoints
  itself, and caches for ~5 min);
- runs `powershell` (Windows) or `sh` + `ls` (macOS / Linux) every ~30 s per Claude Code / omp agent to
  find the newest session transcript by file time;
- reads session transcripts under `~/.omp/agent/sessions/` and `~/.claude/projects/` (only the model name
  is used), and, if present, the herdr-agent-usage cache under `~/.../herdr/plugins/herdr-agent-usage/`;
- makes no network calls of its own and writes no files.

## Limits

- Quota is per provider, not per session: two Claude Code agents show the same numbers.
- The active model comes from the most recently written transcript in the agent's folder, so two omp (or
  two Claude Code) agents in one folder share an answer. Model changes show up within ~40 s.
- Context % is not shown (it is per session and can't be matched to a row).
- It is a modified copy of Herdr's `agents` mod; Herdr never updates it. After an app update, re-clone
  `agents` and re-apply the patch (see `RECIPE.md`, *Built from*).

## License

Apache-2.0, see [LICENSE](LICENSE) and [NOTICE](NOTICE).
