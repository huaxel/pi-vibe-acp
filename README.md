# pi-vibe-acp

Mistral Vibe as a delegation target for [Pi](https://pi.dev), over the
[Agent Client Protocol](https://agentclientprotocol.com/overview/clients).

Pi hands a self-contained task to `vibe-acp`; Vibe runs its own agent loop with
its own tools in the given directory, and Pi gets back the final message plus
token counts. Pi is the client, Vibe is the agent — no Vibe code runs inside
Pi's model loop, and no token from these turns is attributed to Pi's session.

```text
pi ── tool call ──▶ vibe-acp (ACP over stdio) ──▶ Mistral models
      ◀── final text, tool list, token counts ──
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
| `permission` | `deny` | How to answer Vibe's tool-permission requests: `deny`, `ask` (prompt per request, needs a UI), `approve`. |
| `mode` | Vibe's config | Vibe approval policy for the session: `ask`, `accept-edits`, `smart-approve`, `auto-approve`. |
| `model` | Vibe's config | Vibe model alias, e.g. `mistral-large-4-0`. |
| `thinking` | Vibe's config | `off`, `low`, `medium`, `high`, `xhigh`, `max`. |
| `timeoutSeconds` | `900` | Turn budget, 5–3600. |

`/vibe` prints the agent's identity, protocol version, advertised auth methods,
and session options (no prompt, no token spend).

## Permissions

Two layers, and the safer one is the default:

1. **Vibe's own policy** (`mode`) decides which of Vibe's tool calls need
   approval at all. Vibe's `~/.vibe/config.toml` allowlists still apply.
2. **This client** answers each permission request Vibe sends. The default
   `deny` cancels every request, so a delegated turn can investigate and read
   but not act. Use `ask` to approve interactively, or `approve` for autonomous
   work in a directory you trust.

The client advertises no filesystem, terminal, elicitation, or MCP
capabilities, so Vibe uses its own tools and cannot borrow Pi's authority. If an
agent asks anyway, the request is refused with JSON-RPC `-32601`.

## What changes in your Vibe install

Setting `mode` applies to the session only. Setting `model` or `thinking` goes
through Vibe's config mutation, which **persists** to `~/.vibe/config.toml` —
exactly as choosing a model in Vibe's own UI does. Pass them only when you want
that to stick.

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

Vibe's counts land in the tool result's `details.usage` (input/output/total,
plus cache reads when reported), deliberately **not** in Pi's `usage` field: Pi
would add them to its own session totals and bill them against the wrong model.

## Limits

- Replies are capped at 60k characters for the model-facing content; the tail
  is dropped and `details.truncated` is set.
- A turn that exceeds `timeoutSeconds` fails with a message saying Vibe may
  still be working; Pi kills the process when the tool call ends.
- Cancellation sends `session/cancel`, waits up to 5s for the agent to stop
  cleanly, then tears the process down.
- One session per call. There is no resume: Vibe's journals live in
  `~/.vibe`, not in Pi's session tree.

## Development

```bash
npm install
npm test            # offline, against tests/fake-agent.mjs
npm run typecheck
npm run test:live   # real vibe-acp, spends one minimal turn
```

`PI_VIBE_ACP_CLIENT_NAME` overrides the ACP client identity (default `pi`),
which is the knob the metering experiment in [docs/metering.md](docs/metering.md)
uses to test whether client identity affects billing.

The offline suite drives a scripted ACP agent that can misbehave on purpose
(unparsable frames, a dying process, a hung prompt, an unadvertised client
method), so transport failures are covered without touching Mistral.
