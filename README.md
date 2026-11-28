# pi-vibe-acp

Mistral Vibe for [Pi](https://pi.dev), over the
[Agent Client Protocol](https://agentclientprotocol.com/overview/clients) (`vibe-acp`).

Works in two ways:

1. **Pi-native provider (`vibe`)**: Mistral Vibe models (`mistral-large-4-0`, `mistral-medium-latest`, `zai-glm-5-3`, `deepseek-v4-1-flash-1017`, etc.) appear directly in Pi's `/model` picker with per-model thinking levels, live streaming, and warm multi-turn ACP session reuse.
2. **Delegation tool (`vibe`)**: hand a self-contained task to `vibe-acp` from any other model in Pi; Vibe runs its own agent loop with its own tools in the given directory and returns its final message plus token counts.

```text
pi (/model → vibe/*) ── warm ACP session ──▶ vibe-acp ──▶ Mistral models
pi (vibe tool)       ── one-shot ACP run ──▶ vibe-acp ──▶ Mistral models
```

## Why

Two independent reasons, useful separately:

- **A second harness, not a second model provider.** Some tasks want a different
  agent loop (Vibe's approval policies, its own tool allowlists, its own
  session journal). This exposes that loop as one tool.
- **Metering surface.** From 1 December 2026 Mistral counts usage made through
  "third-party coding tools or harnesses" against the monthly free API
  allowance instead of the Vibe allowance. ACP sessions are served by Mistral's
  own `vibe-acp`, and Mistral has confirmed that they keep drawing from the
  Vibe allowance whichever editor launches them
  (see [metering](#metering) and [docs/metering.md](docs/metering.md)).

## Requirements

- Pi with extension support (this package declares `pi.extensions`).
- Mistral Vibe installed, so `vibe-acp` is on `PATH`
  (`uv tool install mistral-vibe` or the official installer). uv installs into
  `%USERPROFILE%\.local\bin` on Windows and does not edit your shell, so add
  that directory to `PATH` yourself. On a Python newer than 3.12, the install
  fails building `tree-sitter` (no wheel yet): pin with
  `uv tool install --python 3.12 mistral-vibe`.
- Vibe signed in: run `vibe --setup` once, or export `MISTRAL_API_KEY`.
  The extension reuses Vibe's own credential store; it never reads your key.

## Install

```bash
pi install ./pi-extensions/pi-vibe-acp          # add to settings
pi -e ./pi-extensions/pi-vibe-acp              # or try it for one invocation
```

## Use

### As a Pi model provider (`/model`)

When `vibe-acp` is on `PATH` (or `VIBE_ACP_BIN` is set), the `vibe` provider is
automatically available in `/model`.

- **Live model & thinking discovery**: models and their supported thinking
  levels are queried directly from `vibe-acp` so Pi's thinking picker only
  offers levels each model actually supports.
- **Warm ACP sessions**: consecutive turns in the same Pi conversation reuse
  the live `vibe-acp` session and send only the incremental delta, computing
  per-turn token deltas from Vibe's session-cumulative usage counters. A branch
  switch, compaction, or `/vibe reset` starts a fresh session cleanly.
- **Permissions like Pi's own tools**: a provider turn does not open a dialog
  per action. Requests default to `approve`, the same posture Pi takes for its
  own tool calls; `ask` restores a dialog per action pattern, and `deny` refuses
  them. Set it with `/vibe mode`, `/vibe permission`, or the env vars
  `PI_VIBE_ACP_MODE` / `PI_VIBE_ACP_PERMISSION`.
- **Vibe's own tool loop**: Vibe decides and executes tool work with its own
  tools, so Pi's tool inventory is not forwarded. Pi sends the project
  instructions (AGENTS.md, skills, cwd) and a note stating that Pi supplies no
  tools. Pi's tool list, MCP inventory, Pi-tool rules ("always pass a reasoning
  phrase to bash", codemode batching) and Pi's docs index are dropped, because
  the model cannot act on any of it and it buries the tools Vibe really has.

What you see in Pi is Vibe's text. Its tool calls are not Pi tool calls, so they
appear as a status-bar line while a turn runs rather than as `bash`/`read`/`edit`
blocks. If you want Pi to own the tool loop — every action rendered and approved
by Pi — use `pi-claude-code`-style providers; ACP agents bring their own.

Commands:
- `/vibe` — print agent identity, protocol version, provider settings, warm session status, and session options (no prompt, no token spend).
- `/vibe mode [ask|accept-edits|smart-approve|auto-approve|default]` — set or pick Vibe's approval policy for provider turns.
- `/vibe permission [deny|ask|approve|default]` — set or pick how provider turns answer Vibe's permission requests.
- `/vibe reset` — close and clear the warm ACP session for this workspace.

### As a delegation tool (`vibe`)

The tool is called `vibe`. Its prompt must be self-contained: Vibe cannot see
Pi's conversation.

```jsonc
{
  "prompt": "In packages/api, find why the health check times out and fix it. Run the test suite when done.",
  "cwd": "packages/api",
  "permission": "approve",
  "mode": "accept-edits",
  "timeoutSeconds": 900
}
```

| Parameter | Default | Meaning |
|---|---|---|
| `prompt` | — | Task for Vibe. Required. |
| `cwd` | current dir | Working directory for the Vibe session. A leading `@` is stripped. |
| `permission` | `approve` | How to answer Vibe's tool-permission requests: `approve` (no dialog), `ask` (prompt per pattern, needs a UI), `deny`. |
| `mode` | Vibe's config | Vibe approval policy for the session: `ask`, `accept-edits`, `smart-approve`, `auto-approve`. |
| `model` | Vibe's config | Vibe model alias, e.g. `mistral-large-4-0`. |
| `thinking` | Vibe's config | `off`, `low`, `medium`, `high`, `xhigh`, `max`. |
| `timeoutSeconds` | `900` | Turn budget, 5–3600. |

`/vibe` prints the agent's identity, protocol version, advertised auth methods,
and session options (no prompt, no token spend).

## Permissions

Vibe's own policy (`mode`) and its configured allowlists decide which
actions run without asking Pi. For example, `accept-edits` can write files
without sending a request. **`permission: "deny"` cancels the requests Pi
receives; it does not make the session read-only.** Use OS-level isolation
when you need to enforce filesystem restrictions.

Provider turns default to `permission: "approve"`, the same posture as Pi's own
tools: Pi does not open a dialog before every tool call, so Vibe's turns do not
either. `deny` is available when you want every request refused.

For interactive review, set `mode: "ask"` and `permission: "ask"`. Each dialog
names the pattern the approval covers, and approving it takes Vibe's
session-scoped grant for that pattern, so the same action does not ask twice.

## Delegating Vibe's actions to Pi (opt-in, inert on 3.1.x)

`PI_VIBE_ACP_CLIENT_TOOLS=1` advertises `fs.writeTextFile` and `terminal` at
`initialize`, so an agent that delegates its file and shell work runs it through
Pi's `write` and `bash` tools instead: Pi's approvals, Pi's sandbox, Pi's
rendering. The request is parked, emitted as a real Pi tool call, and answered
only when Pi reports the result, which resumes the same Vibe turn.

`vibe-acp` 3.1.5 **does not use it**. Its harness runs file and shell tools
against a native executor that has no client mode, and no setting enables one,
so Vibe keeps writing and running commands itself however the client advertises
(this was verified against the live agent: the turn reports no tool calls, and
the file appears with Vibe's own tool activity). Advertising is inert, not
harmful: the smoke test asserts a turn still completes and still produces its
file either way. The flag does not auto-approve Vibe-native tools: Vibe's own
permission requests still follow `/vibe permission` and the configured policy.
The flag exists so a future agent that does delegate gets Pi's tools with no
code change; the path is covered offline against a spec-conformant fake agent.

Delegation reads are deliberately excluded. ACP has no "read only this much"
contract and Pi's `read` truncates at 50 KB, so content truncated on the way to
the model could be written back over the real file.

Without the flag the client advertises no filesystem, terminal, elicitation, or
MCP capabilities, so Vibe uses its own tools and cannot borrow Pi's authority. If an
agent asks anyway, the request is refused with JSON-RPC `-32601`. A test asserts
`clientCapabilities` stays empty.

`ask` declines unidentified tool calls instead of asking you to approve them
blindly. Both `ask` and `approve` prefer a session grant and never select a
permanent one, which would rewrite your Vibe config.

## What changes in your Vibe install

Setting `mode` applies to the session only. Setting `model` or `thinking` goes
through Vibe's config mutation, which **persists** to `~/.vibe/config.toml` —
exactly as choosing a model in Vibe's own UI does. Pass them only when you want
that to stick.

ACP exposes no session-scoped model option, so provider turns have to go
through the same mutation. Two guards keep that off your CLI defaults:

- Model *listing* probes each model's thinking levels on a scratch session and
  then restores your original model, so opening `/model` changes nothing.
- Closing a warm session restores the model and thinking level that were
  persisted before it — every `/vibe reset`, session end, and abort. While a Pi
  session runs on a `vibe/*` model, `~/.vibe/config.toml` names that model; it
  goes back when the session does.

Thinking is only sent when Pi actually picked a level. With no level selected,
Vibe keeps whatever it had, instead of being reset to `off`.

## Metering

Mistral support confirmed in writing (25 November 2026) that a session served
by `vibe-acp` keeps drawing from the Vibe allowance after 1 December 2026, no
matter which editor launched it: what counts is that Vibe is the agent, not the
ACP client name or version the editor declares. Headless `vibe -p` counts the
same way. Only a tool that calls the models with your Vibe key directly moves
to the API allowance.

The classification still happens server-side, so [docs/metering.md](docs/metering.md)
keeps a cheap monthly cross-check: one sized turn after the reset, compared
against both balances. This extension's `details.usage` supplies the token
counts that check needs.

## Token accounting

Two paths, two rules, because the model attribution differs.

**Provider turns** are Pi's own turns on a `vibe/*` model, so their counts belong
in Pi's `usage` — but only the delta for this turn. Vibe reports
session-cumulative counters, so the provider subtracts the previous total; the
second turn of a conversation bills its own prompt, not the whole transcript.

**Tool calls** are a different model's work happening inside Pi's turn, so
Vibe's counts land in the tool result's `details.usage` (input/output/total,
plus cache reads when reported), deliberately **not** in Pi's `usage` field: Pi
would add them to its own session totals and bill them against the wrong model.
Reports that carry counts without a total are kept rather than dropped, and
`details.applied` reports the value Vibe confirmed, not the one requested; if
Vibe kept a different model or mode, the tool result says so.

## Limits

- Replies are capped at 60k characters for the model-facing content; the tail
  is dropped and `details.truncated` is set.
- A turn that exceeds `timeoutSeconds` fails with a message saying Vibe may
  still be working; Pi kills the process when the tool call ends.
- Cancellation sends `session/cancel`, waits up to 5s for the agent to stop
  cleanly, then tears the process down. Cancelling during startup (before the
  turn begins) is honoured too, and reports a cancelled run rather than a
  timeout.
- One session per tool call. The tool does not resume: Vibe's journals live in
  `~/.vibe`, not in Pi's session tree. The provider does keep one warm session
  per workspace, but only while the Pi transcript still matches what Vibe has
  been told.

## Development

```bash
npm install
npm test                  # offline, against tests/fake-agent.mjs
npm run typecheck
npm run test:live          # real vibe-acp, spends three minimal turns
npm run test:live:provider # real vibe-acp, spends two minimal turns
```

`test:live` costs three turns because it checks the paths the offline suite can
only prove against a scripted agent: a plain answer, an approved tool call
(checked via a permission callback and a marker file written in a scratch
directory), and a mid-turn cancel that must start after assistant text arrives,
finish within the abort grace window, and leave no direct child process behind.

`test:live:provider` drives the provider the way Pi does: it asserts text reached
the stream incrementally rather than at the end, and that a second turn in the
same transcript kept the same ACP session and billed only its own delta out of
the cumulative total. `PI_VIBE_LIVE_MODEL` picks the model (default:
`mistral-medium-latest` or another fast one).

`PI_VIBE_ACP_CLIENT_NAME` overrides the ACP client identity (default `pi`),
which is the knob the metering experiment in [docs/metering.md](docs/metering.md)
uses to test whether client identity affects billing.

The offline suite drives a scripted ACP agent that can misbehave on purpose
(unparsable frames, a dying process, a hung prompt, an unadvertised client
method), so transport failures are covered without touching Mistral.

## Releasing

Pushing a `v*.*.*` tag publishes through GitHub Actions; no npm token lives on
a developer machine. The workflow refuses to republish an existing version and
waits for the tarball to become downloadable before reporting success.

```bash
# bump package.json and CHANGELOG.md first
npm run gate
git commit -am "Release X.Y.Z: ..."
git tag -a vX.Y.Z -m "X.Y.Z: ..."
git push origin main --follow-tags
```

Trusted publishing must be configured once on npmjs.com for this package
(GitHub repository `huaxel/pi-vibe-acp`, workflow `publish.yml`; the npm scope
stays `@juanbenjumea`), or the OIDC token exchange in `publish.yml` fails with a
token-exchange error. The first publish after adding or editing the
configuration also validates it — npm shows the trust as pending until then.
