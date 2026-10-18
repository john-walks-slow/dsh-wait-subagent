/**
 * dsh-wait-subagent — wait_subagent tool definition (v1.0 tool, unchanged).
 *
 * Extracted verbatim from the v1.2 single-file implementation as part of
 * the zero-behavior-change split. `defineWaitOneTool(ctx)` is called once
 * per root agent from lib/index.js; `ctx` is the plugin-scoped context
 * (listChildren / agents.get / on) that the tool's execute closes over.
 */

import { defineTool } from "@deepseek-ai/dsh-tools";
import { extractText, lastSnippet, diagnosticsFor } from "../activity.js";
import { summary } from "../summaries.js";

/**
 * @param {import("@deepseek-ai/cordis").Context} ctx plugin-scoped context
 * @returns the registered-ready wait_subagent tool definition
 */
function defineWaitOneTool(ctx) {
  return defineTool({
    name: "wait_subagent",
    description:
      "Block until a background continuable subagent settles (finishes its current turn and all owned children), then return its stop reason and closing message. " +
      "Use this when you started a subagent in the background and your next action depends on its result — instead of guessing or polling with list_agents. " +
      "Prefer omitting timeout_ms and waiting as long as the subagent needs; if you set one, use a generous value — do not poll with repeated short waits. " +
      "On timeout the result includes diagnostics (last observed activity, turn count, recent output) so you can tell stalled from still-working. " +
      "The subagent must be one of your own background children; unknown ids are rejected with an error. " +
      "If the subagent already settled before this call, returns immediately with status 'settled'. " +
      "Settlement includes abnormal endings: error, abort, max-tokens, and refusal all count as settled — tell success from failure via stop_reason. " +
      "Division of labor: wait on a single child with this tool; harvest parallel fan-out one at a time with wait_some_subagent; barrier across all children with wait_every_subagent; probe liveness mid-flight with get_subagent_status.",
    parameters: {
      subagent_id: {
        type: "string",
        required: true,
        description:
          "The subagent id returned when the background subagent was started (the subagentId from the subagent tool's continuable result).",
      },
      timeout_ms: {
        type: "integer",
        description:
          "Maximum milliseconds to wait before returning status 'timeout' (with activity diagnostics). Omit to wait indefinitely — usually the best choice. If set, use a generous value (minutes, not seconds).",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          status: {
            type: "string",
            required: true,
            enum: ["settled", "timeout", "cancelled"],
          },
          subagent_id: { type: "string", required: true },
          // Present only for status 'settled'.
          stop_reason: {
            type: "string",
            enum: ["completed", "aborted", "error", "max-tokens", "refusal", "unknown"],
          },
          closing_message: { type: "string" },
          // Present only for status 'timeout'.
          diagnostics: {
            type: "object",
            additionalProperties: false,
            properties: {
              observed: { type: "boolean", required: true },
              lastActivityAgoMs: { type: "integer" },
              turnCount: { type: "integer" },
              recentOutputs: { type: "array", items: { type: "string" } },
            },
          },
        },
      },
      render: (_args, value) => [{ type: "text", text: summary(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec.agent;
      if (!parent)
        throw new Error("wait_subagent requires a calling agent (exec.agent was undefined)");

      const childId = args.subagent_id;
      // Omitted timeout_ms means wait indefinitely.
      const timeoutMs = args.timeout_ms;

      // Authoritative membership check (same API as list_agents):
      // the continuable projection covers live AND storage-only
      // children, so a bogus id is rejected instead of being
      // misreported as settled. A real child that is not in the live
      // registry already settled (before this call or before this
      // dsh process started).
      const children = await ctx.subagents.listChildren(parent.id, exec.signal);
      if (!children.some((entry) => entry.id === childId)) {
        throw new Error(
          `wait_subagent: "${childId}" is not one of your subagents — pass the id a background dispatch returned (see list_agents)`,
        );
      }
      if (ctx.agents.get(childId) === undefined) {
        return { status: "settled", subagent_id: childId, stop_reason: "unknown" };
      }

      // Wait for the subagent/end lifecycle event (fires when the
      // child's activation is disposed), a timeout, or cancellation.
      // Cordis has no ctx.off(): ctx.on() returns the disposer.
      return new Promise((resolve) => {
        let done = false;
        let timer;
        let disposeEnd;

        function finish(result) {
          if (done) return;
          done = true;
          try {
            cleanup();
          } catch {
            // Cleanup must never crash the process or hang the tool.
          }
          resolve(result);
        }

        function cleanup() {
          if (disposeEnd) disposeEnd();
          exec.signal.removeEventListener("abort", onAbort);
          if (timer) clearTimeout(timer);
        }

        const onEnd = (info) => {
          if (info && info.id === childId) {
            finish({
              status: "settled",
              subagent_id: childId,
              stop_reason: info.stopReason ?? "unknown",
              closing_message:
                extractText(info.lastAssistantMessage) || lastSnippet(childId) || "",
            });
          }
        };

        const onAbort = () => {
          finish({ status: "cancelled", subagent_id: childId });
        };

        // Register on the plugin context — it is an ancestor of all
        // agent contexts, so it receives every scoped subagent/end.
        disposeEnd = ctx.on("subagent/end", onEnd);
        exec.signal.addEventListener("abort", onAbort);

        // Double-check after registering: settlement removes the child
        // from the live registry and dispatches subagent/end in the
        // same synchronous block, so attaching the listener first
        // makes this check race-free.
        if (ctx.agents.get(childId) === undefined) {
          finish({ status: "settled", subagent_id: childId, stop_reason: "unknown" });
        }

        // Optional timeout, now with diagnostics.
        if (timeoutMs && timeoutMs > 0) {
          timer = setTimeout(() => {
            finish({ status: "timeout", subagent_id: childId, diagnostics: diagnosticsFor(childId) });
          }, timeoutMs);
        }
      });
    },
  });
}

export { defineWaitOneTool };
