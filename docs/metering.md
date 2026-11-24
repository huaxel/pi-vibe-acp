# Verifying where ACP usage is metered

This package is useful whether or not ACP traffic stays on the Vibe allowance.
It does not, however, prove that it does — and Mistral has not published a rule.
This page records why the claim is uncertain and how to settle it against your
own account.

## What is actually stated

Mistral's notice of 24 November 2026: from the next billing cycle (1 December
2026), usage made through "non-Mistral products, such as third-party coding
tools or harnesses" counts against the monthly free API allowance instead of
the Vibe allowance, while "dedicated Vibe usage in Mistral products is
unaffected". Both allowances stay the same size; only the bucket changes.

Asked directly, Mistral support (AI agent) answered that the documentation does
not define how third-party harnesses are classified, nor whether ACP client
identity affects billing — so it could not confirm the case either way.

## Why ACP is the ambiguous case

- `vibe-acp` is Mistral's own binary, shipped in the `mistral-vibe` package and
  documented for Zed, JetBrains, Xcode, and Neovim. The agent, its tools, and
  every model request are Vibe's; only the editor is third-party.
- It authenticates with the same plan API key as the terminal CLI — there is no
  separate session token — and its model requests carry
  `user-agent: mistral-client-python/Mistral-Vibe/<version>`.
- ACP `initialize` forwards the connecting client's name and version
  (`clientInfo`), which the agent can report upstream. So a harness called
  `pi` is visible as a third-party client even though the agent is Vibe's.

If Mistral classifies by client, this extension looks third-party. If it
classifies by the serving agent, it looks in-product. The classification lives
on their side; nothing in the client can settle it.

## Procedure

Both allowances reset on the first of the month, so a small run after the reset
is unambiguous. The two Pro buckets differ by roughly 10×, which makes the
direction obvious even for a single turn (~12–13k input tokens).

1. **Record both balances** from `Code › Vibe CLI → View organization usage`
   (the panel shows EUR used against each limit).
2. **Run one sized turn** through this extension, then read
   `details.usage.totalTokens` from the tool result. For a larger signal, run
   several turns; the token count is reported per call.
3. **Re-read the dashboard** after it settles (minutes, occasionally longer).
   Whichever balance moved by roughly that run's cost is the bucket ACP uses.
4. **Repeat with a differently named client** (`PI_VIBE_ACP_CLIENT_NAME=zed`) to
   test whether the declared identity matters.

Two controls are worth running the same day:

- `vibe -p "Reply with exactly: OK" --output json --trust` — headless
  programmatic mode, still Vibe's agent, but not ACP.
- `vibe` in a terminal — the in-product baseline the notice explicitly keeps on
  the Vibe allowance.

## Reading the result

| Vibe balance moved | ACP traffic is in-product; the workflow behaves like the CLI. |
|---|---|
| API balance moved | ACP is classified third-party; the workflow now has ~1/10 of the headroom, and delegated turns consume the API allowance. |
| Neither moved | The dashboard has not settled, or the split is by something else. Re-snapshot before concluding. |

Snapshot the numbers daily for the first week and keep the tool results
alongside them: usage takes time to process, so a later reconciliation could
reclassify what the dashboard showed on day one.

## Calibration, before the change

Measured on 2026-11-24 against `vibe-acp` 3.1.4 with a Pro plan:

- A minimal turn (`Reply with exactly: OK`) costs about 12.4–13.4k input tokens
  and a handful of output tokens: the system prompt and tool definitions
  dominate, not the question.
- Plan models report `cost_usd: 0.0` in Vibe's headless export, so the client
  cannot compute the euro value of a run. The dashboard is the only signal,
  which is why the procedure sizes runs in tokens rather than currency.
- Repeated identical prompts are served from cache (12,416 of 12,422 input
  tokens in one headless run), so vary the prompt when accumulating volume —
  a fully cached run barely moves a balance.
- A session-level `model` change is accepted mid-session and takes effect for
  subsequent turns; note that Vibe persists it (see the README).
