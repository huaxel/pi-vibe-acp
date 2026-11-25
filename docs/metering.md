# Where ACP usage is metered

Mistral has confirmed the case in writing: **ACP traffic stays on the Vibe
allowance.** This page records what was stated, why the question was open, and
how to cross-check the answer against your own account occasionally.

## What is stated

Mistral's notice of 24 November 2026: from the next billing cycle (1 December
2026), usage made through "non-Mistral products, such as third-party coding
tools or harnesses" counts against the monthly free API allowance instead of
the Vibe allowance, while "dedicated Vibe usage in Mistral products is
unaffected". Both allowances stay the same size; only the bucket changes.

Asked to classify ACP specifically, Mistral support answered on 25 November
2026 (Bastien, by email):

> The answer is (a): an ACP session served by vibe-acp keeps drawing from your
> Vibe allowance after December 1. Using Mistral's own Vibe agent through ACP
> inside another editor is allowed. The client name and version your editor
> declares don't change that. What matters is that Vibe is the agent, so the
> same vibe-acp session counts the same way whichever editor launched it.
> vibe -p counts the same way: headless mode is still the Vibe CLI, so
> scripting it doesn't move it to the API allowance. If any of your usage goes
> through another tool that calls the models with your Vibe key directly, only
> that part moves to the €25.50 API allowance from December 1.

So the split follows **who makes the model call**, not the editor, the ACP
client identity, or whether the CLI is interactive. It is a support statement,
not a published rule, which is why the cross-check below is worth running
rather than never re-examining.

## Why it was the ambiguous case

- `vibe-acp` is Mistral's own binary, shipped in the `mistral-vibe` package and
  documented for Zed, JetBrains, Xcode, and Neovim. The agent, its tools, and
  every model request are Vibe's; only the editor is third-party.
- It authenticates with the same plan API key as the terminal CLI — there is no
  separate session token — and its model requests carry
  `user-agent: mistral-client-python/Mistral-Vibe/<version>`.
- ACP `initialize` forwards the connecting client's name and version
  (`clientInfo`), which the agent can report upstream, so a harness called `pi`
  is visible as a third-party client even though the agent is Vibe's.

The first two point at in-product and the third points at third-party. Mistral
resolved it on the agent, not the client.

## Cross-check

Both allowances reset on the first of the month, so a small run after the reset
is unambiguous. The two Pro buckets differ by roughly 10×, which makes the
direction obvious even for a single turn (~12–13k input tokens).

1. **Record both balances** from `Code › Vibe CLI → View organization usage`
   (the panel shows EUR used against each limit).
2. **Run one sized turn** through this extension, then read
   `details.usage.totalTokens` from the tool result. For a larger signal, run
   several turns; the token count is reported per call.
3. **Re-read the dashboard** after it settles (minutes, occasionally longer).
   The Vibe balance should have moved by roughly that run's cost. An API-balance
   move means the classification changed and the workflow now has ~1/10 of the
   headroom.
4. Optionally repeat with `PI_VIBE_ACP_CLIENT_NAME=zed` to confirm the declared
   identity still makes no difference — support says it does not.

Controls worth running the same day if a result looks wrong:

- `vibe -p "Reply with exactly: OK" --output json --trust` — headless
  programmatic mode, which support placed in the Vibe bucket too.
- `vibe` in a terminal — the in-product baseline the notice explicitly keeps on
  the Vibe allowance.

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
