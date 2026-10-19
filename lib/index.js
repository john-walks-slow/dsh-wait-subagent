/**
 * dsh-wait-subagent v1.2 — active wait + liveness status for background
 * continuable subagents in DeepSeek Harness.
 *
 * Tool surface — four tools on every root agent (local plugin, so superseded
 * names are removed outright, no compatibility aliases):
 *   - `wait_subagent(subagent_id, timeout_ms?)` — block until one background
 *     child settles and return its stop reason + closing message (v1.0).
 *   - `get_subagent_status(subagent_id)` — non-blocking liveness probe
 *     (v1.2 rename; semantics, parameters, and output are unchanged).
 *   - `wait_some_subagent(subagent_ids[], timeout_ms?)` — block until the
 *     FIRST of the listed children settles (v1.2 rename of the v1.1
 *     first-of-N tool; implementation and semantics unchanged, description
 *     refreshed). For harvesting parallel fan-outs one result at a time.
 *   - `wait_every_subagent(subagent_ids[], timeout_ms?)` — barrier: block
 *     until EVERY listed child has settled, then return per-child results in
 *     input order plus a `failed` list (ids whose stop_reason is not
 *     "completed"); on timeout the still-running ids are listed under
 *     `pending` with activity diagnostics (v1.2, new).
 *   Across all three waits, settlement includes abnormal endings: error /
 *   aborted / max-tokens / refusal all fire `subagent/end` and count as
 *   settled; stop_reason distinguishes success from failure, so a failing
 *   child can never hang a wait.
 *
 * DSH's subagent system provides:
 *   - `subagent` with run_in_background:true → returns a subagentId, work
 *     continues asynchronously; the runtime sends a settlement notice later.
 *   - `send_message` → fire-and-return (never waits for the answer).
 *   - `list_agents` → snapshot, not a wait (and explicitly "not to poll").
 *
 * Registration pattern: same as dsh-proactive — listen for `agent/created`,
 * register tools on every root agent's scoped context via `agentCtx.tools`.
 *
 * Wait mechanism: the `subagent/end` lifecycle event fires when a child
 * settles (after its activation is disposed). The plugin context is an
 * ancestor of all agent contexts, so a listener on `ctx` receives the event
 * for any child. Settlement removes the child from the live registry and
 * dispatches the event in the same synchronous block (finishDisposal), so
 * the race-free order is: attach listener, then re-check the registry.
 *
 * Liveness mechanism (v1.1, best-effort): subscribe to `subagent/
 * assistant-output` and `agent/status` on the plugin context. Payload shapes
 * are intentionally feature-detected; unresolvable payloads are ignored.
 * Observed activity feeds `get_subagent_status` and the timeout diagnostics;
 * absence of observations is reported honestly ("not observed") rather than
 * guessed about.
 *
 * Membership gate: ctx.subagents.listChildren(parent.id) — the same
 * projection list_agents reads — covers live AND storage-only children,
 * so unknown ids are rejected with an error instead of being
 * misreported as settled; a known child absent from the live registry has
 * already settled.
 *
 * Module layout (v1.2 single-file → multi-file split, behavior unchanged):
 *   - lib/activity.js    — liveness tracking: constants, module-level
 *     activity Map, extractText/extractId/extractSnippet, noteActivity,
 *     diagnosticsFor, lastSnippet, describeDiagnostics. The Map is a module
 *     singleton shared by all importers.
 *   - lib/summaries.js   — human-readable result renderers shared by the
 *     tools: summary, summaryEvery, statusSummary.
 *   - lib/tools/wait-one.js  — defineWaitOneTool(ctx): wait_subagent.
 *   - lib/tools/status.js    — defineGetStatusTool(ctx): get_subagent_status.
 *   - lib/tools/wait-some.js — defineWaitSomeTool(ctx): wait_some_subagent.
 *   - lib/tools/wait-every.js — defineWaitEveryTool(ctx): wait_every_subagent.
 *   This file (lib/index.js) wires it all: plugin-level liveness
 *   subscriptions, per-root-agent tool registration via the four factories,
 *   and the agent/created listener.
 */

import { extractId, extractSnippet, noteActivity } from "./activity.js";
import { defineWaitOneTool } from "./tools/wait-one.js";
import { defineGetStatusTool } from "./tools/status.js";
import { defineWaitSomeTool } from "./tools/wait-some.js";
import { defineWaitEveryTool } from "./tools/wait-every.js";

const name = "dsh-wait-subagent";
const inject = ["agents", "tools", "subagents"];

function apply(ctx) {
  const registered = new WeakSet();

  // Best-effort liveness subscriptions at plugin scope (auto-disposed with
  // the plugin fiber). Unknown payload shapes are ignored silently.
  try {
    ctx.on("subagent/assistant-output", (info) => {
      const id = extractId(info);
      if (id) noteActivity(id, extractSnippet(info));
    });
  } catch {
    // Event not available on this DSH version — liveness features degrade.
  }
  try {
    ctx.on("agent/status", (info) => {
      const id = extractId(info);
      if (id) noteActivity(id, "");
    });
  } catch {
    // Event not available on this DSH version — liveness features degrade.
  }

  function registerOne(agent) {
    if (registered.has(agent)) return;
    // Only root agents get the tools (same gate as dsh-proactive).
    if (!ctx.agents.roots().includes(agent)) return;
    registered.add(agent);

    agent.ctx.effect(
      () => {
        const disposeWait = agent.ctx.tools.register(defineWaitOneTool(ctx));
        const disposeStatus = agent.ctx.tools.register(defineGetStatusTool(ctx));
        const disposeSome = agent.ctx.tools.register(defineWaitSomeTool(ctx));
        const disposeEvery = agent.ctx.tools.register(defineWaitEveryTool(ctx));

        return () => {
          disposeWait();
          disposeStatus();
          disposeSome();
          disposeEvery();
        };
      },
      "dsh-wait-subagent:tools",
    );
  }

  // Register on existing root agents and listen for new ones.
  // Plugin-scoped ctx.on registrations auto-dispose with the plugin fiber,
  // so no manual cleanup is needed here.
  ctx.on("agent/created", ({ agent }) => registerOne(agent));
  for (const existing of ctx.agents.roots()) registerOne(existing);
}

export { apply, inject, name };
