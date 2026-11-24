# Changelog

## [0.1.0]

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
