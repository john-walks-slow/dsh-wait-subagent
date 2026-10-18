# dsh-wait-subagent

<p align="center">
  <a href="./README.md"><strong>English</strong></a> ·
  <a href="./README.zh-CN.md"><strong>简体中文</strong></a>
</p>

A DeepSeek Harness (cordis) plugin that registers four model-facing tools:

- `wait_subagent` — **block until a background continuable subagent settles, then get its stop reason and closing message** in the same call; timeouts carry activity diagnostics (last activity age, turn count, recent outputs) so you can tell "still working" from "likely stalled".
- `get_subagent_status` — **non-blocking liveness probe**: is the child still running, how long since its last activity, what did it recently output — for mid-flight "working vs silently stalled" decisions.
- `wait_some_subagent` — **wait for the FIRST of several background subagents to settle**, returning that id / stop reason / closing message — for harvesting parallel fan-out dispatches one by one.
- `wait_every_subagent` — **barrier: wait for ALL of the listed background subagents to settle**, returning every child's result in input order plus a `failed` list — for joins where your next step needs all fan-out results at once.

Across the three wait tools, **settlement includes abnormal endings**: `error`, `aborted`, `max-tokens`, and `refusal` all count as settled (each fires the same lifecycle event as a normal finish); `stop_reason` tells success from failure, so a failing child can never hang a wait.

It fills a real gap in the subagent workflow: `run_in_background` returns a `subagentId` immediately, but the only way to learn the outcome is an async settlement notice (which can arrive late or never), and there was no tool to actively wait or probe liveness mid-flight.

## Real output

Start a subagent in the background, then wait for it:

```
wait_subagent({ subagent_id: "session-9f2c47ab-83d1-4e06-b5a9-1c7f2d84e0b3" })
```

The call blocks while the subagent runs. When it settles, the tool returns:

```json
{
  "status": "settled",
  "subagent_id": "session-9f2c47ab-83d1-4e06-b5a9-1c7f2d84e0b3",
  "stop_reason": "completed",
  "closing_message": "Spec written to docs/plan.md; 3 files changed, ready for review."
}
```

The text the model sees:

```
Subagent session-9f2c47ab-83d1-4e06-b5a9-1c7f2d84e0b3 settled: completed
Spec written to docs/plan.md; 3 files changed, ready for review.
```

Other outcomes:

| Situation | Result |
|---|---|
| Subagent already settled before the call | `{ "status": "settled", "subagent_id": "…", "stop_reason": "unknown" }` — *"had already settled before this call; its closing message was delivered separately as a settlement notice."* |
| `timeout_ms` elapsed | `{ "status": "timeout", "subagent_id": "…", "diagnostics": { "observed": true, "lastActivityAgoMs": 412000, "turnCount": 7, "recentOutputs": ["…"] } }` — *"Timed out waiting for subagent …"* + activity diagnostics (honest `observed: false` when nothing was observed) |
| Caller's `AbortSignal` fired | `{ "status": "cancelled", "subagent_id": "…" }` |
| Unknown / foreign subagent id | Rejected with an error: *"… is not one of your subagents — pass the id a background dispatch returned (see list_agents)"* |

## The v1.2 tools

### get_subagent_status — mid-flight liveness probe

```
get_subagent_status({ subagent_id: "…" })
→ { "status": "running" | "settled", "observed": true,
    "lastActivityAgoMs": 12345, "turnCount": 6, "recentOutputs": ["…", "…"] }
```

- Returns immediately; use it to decide between keep-waiting / interrupt / re-dispatch.
- Observations come from the plugin's subscriptions to `subagent/assistant-output` and `agent/status` events (payload shapes are feature-detected; unknown shapes are ignored).
- `observed: false` means the plugin saw no activity from that child — reported honestly, not guessed.

### wait_some_subagent — first-of-N harvest

```
wait_some_subagent({ subagent_ids: ["id-a", "id-b", "id-c"] })
→ { "status": "settled", "subagent_id": "id-b",
    "stop_reason": "completed", "closing_message": "…" }
```

- Pass ≥2 ids; blocks until ANY one settles and returns it. Call repeatedly (dropping settled ids) to harvest parallel dispatches one at a time.
- Returns immediately if any listed child has already settled (`stop_reason: "unknown"`); timeouts carry diagnostics for the least-recently-active id.

### wait_every_subagent — barrier until all settle

```
wait_every_subagent({ subagent_ids: ["id-a", "id-b"] })
→ { "status": "settled",
    "results": [
      { "subagent_id": "id-a", "stop_reason": "completed",
        "closing_message": "Spec written to docs/plan.md." },
      { "subagent_id": "id-b", "stop_reason": "error",
        "closing_message": "npm install failed: peer dep conflict." } ],
    "failed": ["id-b"] }
```

The text the model sees:

```
Subagent id-a settled: completed
Spec written to docs/plan.md.
Subagent id-b settled: error
npm install failed: peer dep conflict.
Failed: id-b
```

- Pass ≥2 ids; blocks until EVERY one has settled, then returns the per-child results **in input order** plus `failed` (the ids whose `stop_reason` is not `"completed"`, present only when non-empty).
- Children that already settled before the call are reported with `stop_reason: "unknown"`; abnormal endings (`error` / `aborted` / `max-tokens` / `refusal`) settle like normal finishes and never hang the barrier.
- On timeout, the result lists the still-running ids under `pending` (with activity diagnostics) and carries no partial results — re-call the tool afterwards or fall back to per-child waits.

## Why

What the subagent system gives you today:

- `subagent` with `run_in_background: true` → returns a `subagentId` at once; work continues asynchronously and a settlement notice arrives later.
- `subagent` with `run_in_background: false` → blocks at **start** time only.
- `send_message` → fire-and-return, never waits for the answer.
- `list_agents` → a snapshot, not a wait (and explicitly "not to poll").

What's missing: after starting a subagent in the background, there is no tool to **block and wait** for it to finish. That is exactly what `wait_subagent` does — use it when your next action depends on the subagent's result, instead of guessing or polling. For parallel dispatches, pick the wait shape that matches your flow: `wait_some_subagent` to harvest one result at a time (loop it), `wait_every_subagent` for a barrier before a step that needs everything.

## How it works

- Registers four tools on every root agent (same pattern as `dsh-proactive`).
- **Membership gate**: `ctx.subagents.listChildren(parent.id)` — the same projection `list_agents` reads — covers live AND storage-only children, so unknown ids are rejected with an error instead of being misreported as settled. A known child absent from the live registry has already settled.
- The waiting tools listen for the `subagent/end` lifecycle event — which fires when a child's activation is disposed — scoped through the plugin context (an ancestor of all agent contexts). `wait_every_subagent` records one result per listed id from the same event stream and resolves only once every id is recorded.
- Settlement removes the child from the live registry and dispatches `subagent/end` in the same synchronous block (`finishDisposal`), so attaching the listener first and then re-checking the registry is race-free. A child missing from the registry at that point is recorded as already settled (`stop_reason: "unknown"`).
- **Liveness tracking (v1.1)**: the plugin context subscribes to `subagent/assistant-output` and `agent/status`, maintaining a per-child activity table (last activity time, turn count, last 5 output snippets of 200 chars each, 256-id LRU cap). Payload shapes are feature-detected (`id` / `subagentId` / `agentId` / `agent.id`); unknown shapes are ignored — if the events are missing or shaped differently, liveness features degrade gracefully and the waiting tools keep working.
- Optional `timeout_ms` returns `status: "timeout"` with `diagnostics` (or, for `wait_every_subagent`, the `pending` list; honest `observed: false` when nothing was seen). Omit to wait indefinitely — usually the best choice.
- Respects the caller's `AbortSignal` (returns `status: "cancelled"`).

## Tool schema

```
wait_subagent(subagent_id: string, timeout_ms?: integer)
→ { status: "settled" | "timeout" | "cancelled",
    subagent_id: string,
    stop_reason?: "completed" | "aborted" | "error" | "max-tokens" | "refusal" | "unknown",
    closing_message?: string,
    diagnostics?: { observed: boolean, lastActivityAgoMs?: integer,
                    turnCount?: integer, recentOutputs?: string[] } }

get_subagent_status(subagent_id: string)
→ { status: "running" | "settled", subagent_id: string, observed: boolean,
    lastActivityAgoMs?: integer, turnCount?: integer, recentOutputs?: string[] }

wait_some_subagent(subagent_ids: string[2+], timeout_ms?: integer)
→ { status: "settled" | "timeout" | "cancelled",
    subagent_id: string,   // first settler (or timeout diagnostics subject)
    stop_reason?: …, closing_message?: string, diagnostics?: … }

wait_every_subagent(subagent_ids: string[2+], timeout_ms?: integer)
→ { status: "settled" | "timeout" | "cancelled",
    results?: [ { subagent_id: string,
                  stop_reason: "completed" | "aborted" | "error" | "max-tokens" | "refusal" | "unknown",
                  closing_message: string }, … ],   // input order, on settled
    failed?: string[],                              // stop_reason != "completed", when non-empty
    pending?: [ { subagent_id: string, observed: boolean,
                  lastActivityAgoMs?: integer, turnCount?: integer,
                  recentOutputs?: string[] }, … ] } // still-running ids, on timeout
```

## Caveat: don't wait and interrupt in the same step

`wait_subagent` is concurrency-safe, but `interrupt_agent` is not — it needs the tool
lane exclusively and queues behind any in-flight call. Issuing `wait_subagent` and
`interrupt_agent` in one parallel step serializes them: the wait runs to its timeout
first, and only then does the interrupt land. Call `interrupt_agent` first, then
`wait_subagent` in the next step (an already-interrupted child settles quickly).

## Install

```bash
dsh plugin --profile web add dsh-wait-subagent
```

Or straight from GitHub (source install — plain ESM JavaScript, no build step, so pnpm ≥ 10 build-script approval is not needed):

```bash
dsh plugin --profile web add github:john-walks-slow/dsh-wait-subagent
```

Restart your DSH instance after installing; the bundled `cordis.patch.yml` registers the loader entry automatically.

## Permissions & compatibility

- **What it touches**: registers exactly four model-facing Agent tools (`wait_subagent`, `get_subagent_status`, `wait_some_subagent`, `wait_every_subagent`) on every root agent. No web client, no UI changes, no configuration.
- **Blocking semantics**: the waiting tools hold the calling agent's tool lane until the targets settle, the optional timeout elapses, or the caller aborts — that is the feature. The wait itself is event-driven (`subagent/end` lifecycle event), not polling; CPU cost while blocked is negligible. `get_subagent_status` returns immediately and never blocks. An omit-`timeout_ms` wait is unbounded by design; set a generous `timeout_ms` when you need a bound.
- **No side effects**: no network requests, no external services, no filesystem writes. The activity table lives in plugin process memory only (cleared on restart).
- **Dependencies**: `@deepseek-ai/dsh-tools` 0.1.2-rc.1 (aligned with the dsh 0.1.2-rc.1 locked version), Node ≥ 22.5.

## Local development

```bash
npm install
npm run verify        # runs scripts/verify.mjs — static + mock functional checks
```

That's it — `lib/` is plain ESM JavaScript; there is no build step.

## Release a new version

```bash
npm run release        # bumps the patch version and packs /tmp/dsh-wait-subagent-<newver>.tgz
```

Then publish the tarball to npm and push the version commit and tag:

```bash
git push --follow-tags
```

Verify with `npm view dsh-wait-subagent version`.

## License

MIT

## Community

- Thanks to the [LINUX DO](https://linux.do/) community for providing the discussion environment.
