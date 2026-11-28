# Changelog

## [0.3.0] - 2026-11-28

- Stop opening a permission dialog for every action Vibe takes. Provider turns
  now default to `permission: "approve"`, matching Pi's own posture: Pi does not
  ask before each tool call, so a Vibe turn does not either. `deny` remains
  available, and `ask` keeps a dialog per pattern.
- `permission: "ask"` now takes the session-scoped grant the dialog names, so
  approving an action stops the identical request from returning on the next
  turn, and the dialog shows the requirement Vibe only describes in option
  metadata (`outside workdir (/etc/hostname)`).
- Add an opt-in ACP client-tool bridge (`PI_VIBE_ACP_CLIENT_TOOLS=1`): an agent
  that delegates writes and shell commands runs them through Pi's `write` and
  `bash` tools, with Pi's approvals and rendering, and the parked request is
  answered from Pi's real result. `vibe-acp` 3.1.5 never delegates, so the flag
  is off by default and inert there; it is covered offline against a fake agent.
  Vibe-native permission requests still obey the configured policy, even with
  the bridge opted in. A malformed write fails instead of reporting a write that
  never happened, truncated command output is reported as truncated rather than
  passed off as the whole result, and the terminal table is bounded.
- Stop forwarding Pi's tool inventory to Vibe. The provider used to send Pi's
  whole system prompt, whose `<tools>` and `<mcp_servers>` sections list Pi
  tools (`read`, `bash`, `edit`, `agy_*`, codemode) and their rules. Vibe has
  none of those, so the model was described a harness it was not in and its own
  tools went unmentioned. The `rules` section (how to call those tools) and the
  `docs` index (Pi's own documentation) are dropped for the same reason;
  `preamble`, `cwd`, `skills`, and `project_context` still reach Vibe. Project instructions, skills, and cwd still apply, and
  a `<pi_acp_runtime>` note now states that Pi supplies no tools and only shows
  the reply.

## [0.2.0] - 2026-11-28

Mistral Vibe is now a Pi model provider as well as a delegation tool: with
`vibe-acp` installed, `vibe/*` models show up in `/model` and behave like any
other Pi model.

- Mistral Vibe models appear in `/model` with per-model thinking levels
  discovered live over ACP, `agent_thought_chunk`/`agent_message_chunk`
  streamed as Pi thinking and text deltas, live tool activity in the status
  bar, and Pi confirmation dialogs for Vibe's permission requests.
- Consecutive turns in one Pi conversation reuse the warm `vibe-acp` session
  and send only the incremental prompt delta; a branch switch, compaction, or
  `/vibe reset` starts a fresh session. Per-turn token counts are subtracted
  from Vibe's session-cumulative usage so Pi reports this turn, not the session.
- Concurrent turns in one workspace are serialized. One ACP session cannot take
  two prompts at once, so an unserialized pair lost one turn's updates and then
  hung waiting for a reply that could never arrive.
- Discovery probes each model's thinking levels on a scratch session and then
  restores the user's own model, so listing models never edits
  `~/.vibe/config.toml`; closing a warm session likewise restores the model and
  thinking level that were persisted before it, so a Pi session on `vibe/*`
  does not permanently change the `vibe` CLI default.
- Thinking is only sent to Vibe when Pi picked a level, so a turn without an
  explicit level no longer resets the user's persisted choice to `off`.
- `/vibe` gains `mode`, `permission`, and `reset` subcommands; bare `/vibe`
  still prints the doctor report, now including warm session status.
- `npm run test:live:provider` adds a two-turn live check of the provider path:
  incremental deltas and, on the second turn, the same ACP session billed only
  the delta rather than a replayed transcript.

## [0.1.1] - 2026-11-27

- Clarify that client permission policy only affects requests Vibe sends to Pi.
  Resolve permission requests to their tool titles, decline unidentified actions,
  and never select permanent grants.
- Show failed tool calls and their error messages in Pi. Let the cancellation
  grace window take precedence over a turn timeout once cancellation starts.
- The three-turn `npm run test:live` now checks an approval and its filesystem
  effect, and requires the mid-turn cancellation to start after text arrives.
- The changelog collapses the first release under one dated `0.1.0` heading.
  Everything it listed had shipped, so `[Unreleased]` was claiming published
  work was still pending.

## [0.1.0] - 2026-11-26

Initial release: a `vibe` tool that delegates one self-contained task to Mistral
Vibe's own agent over ACP (`vibe-acp`), plus a `/vibe` doctor command.

- ACP client over stdio with newline-delimited JSON-RPC: every request settles
  on response, timeout, abort, agent exit, or dispose — never hangs.
- Permission control: `deny` (default), `ask` (interactive), `approve`, mapped
  onto Vibe's tool-permission requests; no filesystem, terminal, or MCP
  capabilities are advertised, so Vibe cannot borrow Pi's authority.
- Session options: `mode` (Vibe approval policy), `model`, `thinking`, with a
  clear error listing valid values when Vibe refuses one.
- Streaming progress to the TUI, Vibe token counts in `details.usage` rather
  than Pi's usage, 60k reply cap, 900s default turn budget, and cancellation
  that gives the agent a grace window before teardown.
- Actionable failures: missing `vibe-acp` explains installation, missing
  credentials explain `vibe --setup`, timeouts say the turn may still be live.
- Offline test suite against a scripted ACP agent, plus a live smoke test.
- Metering: Mistral confirmed that `vibe-acp` sessions stay on the Vibe
  allowance whichever editor launches them (see `docs/metering.md`).

### Hardening before the first publish

- A `cwd` that does not exist is reported as such, instead of as "vibe-acp is
  not installed": Node raises the same `ENOENT` for a bad cwd and a missing
  binary.
- A blank `VIBE_ACP_BIN` is treated as unset rather than crashing `spawn`, and
  startup failures are translated like turn failures instead of leaking raw
  errors.
- `permission: "ask"` selects the once-only grant whenever Vibe offers one,
  whatever order Vibe lists the options in, and says the grant is session-wide
  when that is all that is on offer.
- Tests: assert that no client capabilities are advertised, and cover grant
  preference, blank command overrides, a missing cwd, startup-failure
  translation, the abort grace window, and startup cancellation.
- `mode` is set with `session/set_mode` for agents that expose modes without a
  `mode` config option; Vibe itself exposes the config option, so this is the
  fallback path.
- `session/set_config_option` sends `type: "id"` for string values, per ACP
  ("select" is not a valid value type). Verified against `vibe-acp` 3.1.5,
  which accepts both.
- Cancellation is wired through `initialize`, `session/new`, and option
  handling, so an abort during startup lands at once (no grace window, since
  those requests have no cancel notification) and reports a cancelled run. An
  already-aborted signal does not start Vibe at all.
- Token counts survive partial reports: an update carrying counts without a total
  is kept instead of discarded, and a later report never shrinks the total.
- `details.applied` reports the value Vibe confirmed in its response, not the
  one requested, since an agent may adjust it; when it differs, the tool result
  tells the model which option Vibe kept.
- `/vibe` translates startup failures (such as a missing binary) like the tool.
- `session/close` is only called when the agent advertises
  `sessionCapabilities.close`, as ACP v1 requires.
