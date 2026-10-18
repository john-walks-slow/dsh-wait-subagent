/**
 * dsh-wait-subagent — wait_every_subagent tool definition (v1.2, new
 * barrier tool).
 *
 * Extracted verbatim from the v1.2 single-file implementation as part of
 * the zero-behavior-change split. `defineWaitEveryTool(ctx)` is called
 * once per root agent from lib/index.js; `ctx` is the plugin-scoped
 * context (listChildren / agents.get / on) that the tool's execute
 * closes over.
 */

import { defineTool } from "@deepseek-ai/dsh-tools";
import { extractText, lastSnippet, diagnosticsFor } from "../activity.js";
import { summaryEvery } from "../summaries.js";

/**
 * @param {import("@deepseek-ai/cordis").Context} ctx plugin-scoped context
 * @returns the registered-ready wait_every_subagent tool definition
 */
function defineWaitEveryTool(ctx) {
  return defineTool({
    name: "wait_every_subagent",
    description:
      "Block until EVERY listed background subagent has settled, then return each child's id, stop reason, and closing message, ordered as the input ids. " +
      "Settlement includes abnormal endings: error, abort, max-tokens, and refusal all count as settled, so a failing child can never hang this wait — tell success from failure via stop_reason; the failed list collects the ids whose stop_reason is not 'completed'. " +
      "Use this as a barrier/join when your next action needs all the fan-out results at once (e.g. merging parallel reports before continuing). " +
      "To harvest one result at a time as children finish instead, use wait_some_subagent; for a single child use wait_subagent; to probe liveness mid-flight without blocking use get_subagent_status. " +
      "Every listed id must be one of your own subagents; children that already settled before the call are reported with stop_reason 'unknown'. " +
      "Prefer omitting timeout_ms and waiting as long as the children need; if you set one, use a generous value (minutes, not seconds) — on timeout the still-running ids are listed under pending (no partial results).",
    parameters: {
      subagent_ids: {
        type: "array",
        items: { type: "string" },
        required: true,
        description: "Two or more subagent ids returned by background dispatches.",
      },
      timeout_ms: {
        type: "integer",
        description:
          "Maximum milliseconds to wait before returning status 'timeout' (with the still-running ids listed under pending). Omit to wait indefinitely — usually the best choice.",
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
          // Present only for status 'settled', in input-id order.
          results: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                subagent_id: { type: "string", required: true },
                stop_reason: {
                  type: "string",
                  required: true,
                  enum: ["completed", "aborted", "error", "max-tokens", "refusal", "unknown"],
                },
                closing_message: { type: "string", required: true },
              },
            },
          },
          // Present for status 'settled' when non-empty.
          failed: { type: "array", items: { type: "string" } },
          // Present only for status 'timeout'.
          pending: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                subagent_id: { type: "string", required: true },
                observed: { type: "boolean", required: true },
                lastActivityAgoMs: { type: "integer" },
                turnCount: { type: "integer" },
                recentOutputs: { type: "array", items: { type: "string" } },
              },
            },
          },
        },
      },
      render: (args, value) => [{ type: "text", text: summaryEvery(args, value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec.agent;
      if (!parent)
        throw new Error("wait_every_subagent requires a calling agent (exec.agent was undefined)");

      // Dedupe, preserve order, require at least two distinct ids.
      const ids = [...new Set((args.subagent_ids ?? []).filter(
        (id) => typeof id === "string" && id.length > 0,
      ))];
      if (ids.length < 2) {
        throw new Error(
          "wait_every_subagent: pass at least two distinct subagent ids (use wait_subagent for a single child)",
        );
      }
      const timeoutMs = args.timeout_ms;

      // Same membership gate as the other waits.
      const children = await ctx.subagents.listChildren(parent.id, exec.signal);
      const known = new Set(children.map((entry) => entry.id));
      for (const id of ids) {
        if (!known.has(id)) {
          throw new Error(
            `wait_every_subagent: "${id}" is not one of your subagents — pass the ids background dispatches returned (see list_agents)`,
          );
        }
      }

      const idSet = new Set(ids);
      /** @type {Map<string, {subagent_id:string, stop_reason:string, closing_message:string}>} */
      const results = new Map();
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

        // Record one settled child; resolve only when the barrier
        // completes (every listed id recorded, input order preserved).
        const recordEnd = (id, stopReason, closingMessage) => {
          if (results.has(id)) return;
          results.set(id, { subagent_id: id, stop_reason: stopReason, closing_message: closingMessage });
          if (results.size === ids.length) {
            const ordered = ids.map((id) => results.get(id));
            const failed = ordered
              .filter((r) => r.stop_reason !== "completed")
              .map((r) => r.subagent_id);
            finish({
              status: "settled",
              results: ordered,
              ...(failed.length > 0 ? { failed } : {}),
            });
          }
        };

        const onEnd = (info) => {
          if (info && typeof info.id === "string" && idSet.has(info.id)) {
            recordEnd(
              info.id,
              info.stopReason ?? "unknown",
              extractText(info.lastAssistantMessage) || lastSnippet(info.id) || "",
            );
          }
        };

        const onAbort = () => {
          finish({ status: "cancelled" });
        };

        // Register on the plugin context — it is an ancestor of all
        // agent contexts, so it receives every scoped subagent/end.
        disposeEnd = ctx.on("subagent/end", onEnd);
        exec.signal.addEventListener("abort", onAbort);

        // Race-free re-check (same synchronous-block argument as the
        // other waits): children absent from the live registry have
        // already settled; record them as 'unknown'. The barrier
        // resolves only once every listed id is recorded.
        for (const id of ids) {
          if (ctx.agents.get(id) === undefined) {
            recordEnd(id, "unknown", "");
          }
        }

        if (timeoutMs && timeoutMs > 0) {
          timer = setTimeout(() => {
            const pending = ids
              .filter((id) => !results.has(id))
              .map((id) => ({ subagent_id: id, ...diagnosticsFor(id) }));
            finish({ status: "timeout", pending });
          }, timeoutMs);
        }
      });
    },
  });
}

export { defineWaitEveryTool };
