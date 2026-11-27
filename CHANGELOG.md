# Changelog

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
