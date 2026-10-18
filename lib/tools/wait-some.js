/**
 * dsh-wait-subagent — wait_some_subagent tool definition (v1.1
 * first-settler wait, renamed + described anew in v1.2; implementation
 * and semantics unchanged).
 *
 * Extracted verbatim from the v1.2 single-file implementation as part of
 * the zero-behavior-change split. `defineWaitSomeTool(ctx)` is called
 * once per root agent from lib/index.js; `ctx` is the plugin-scoped
 * context (listChildren / agents.get / on) that the tool's execute
 * closes over.
 */

import { defineTool } from "@deepseek-ai/dsh-tools";
import { extractText, lastSnippet, diagnosticsFor } from "../activity.js";
import { summary } from "../summaries.js";

/**
 * @param {import("@deepseek-ai/cordis").Context} ctx plugin-scoped context
 * @returns the registered-ready wait_some_subagent tool definition
 */
function defineWaitSomeTool(ctx) {
  return defineTool({
    name: "wait_some_subagent",
    description:
      "Block until the FIRST of the listed background subagents settles, then return that subagent's id, stop reason, and closing message. " +
      "Settlement includes abnormal endings: error, abort, max-tokens, and refusal all count as settled — tell success from failure via stop_reason. " +
      "Use this to harvest parallel fan-out dispatches one at a time without polling: call it repeatedly (re-listing the still-running ids) until all children are collected. " +
      "When you need a barrier instead — continue only after every child has finished — use wait_every_subagent; for a single child use wait_subagent; to probe liveness mid-flight without blocking use get_subagent_status. " +
      "Every listed id must be one of your own subagents; if any listed child has already settled, returns immediately with that id and stop_reason 'unknown'. " +
      "Prefer omitting timeout_ms; if you set one, use a generous value (minutes, not seconds).",
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
          "Maximum milliseconds to wait before returning status 'timeout' (with per-id diagnostics). Omit to wait indefinitely — usually the best choice.",
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
          stop_reason: {
            type: "string",
            enum: ["completed", "aborted", "error", "max-tokens", "refusal", "unknown"],
          },
          closing_message: { type: "string" },
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
        throw new Error("wait_some_subagent requires a calling agent (exec.agent was undefined)");

      // Dedupe, preserve order, require at least two distinct ids.
      const ids = [...new Set((args.subagent_ids ?? []).filter(
        (id) => typeof id === "string" && id.length > 0,
      ))];
      if (ids.length < 2) {
        throw new Error(
          "wait_some_subagent: pass at least two distinct subagent ids (use wait_subagent for a single child)",
        );
      }
      const timeoutMs = args.timeout_ms;

      const children = await ctx.subagents.listChildren(parent.id, exec.signal);
      const known = new Set(children.map((entry) => entry.id));
      for (const id of ids) {
        if (!known.has(id)) {
          throw new Error(
            `wait_some_subagent: "${id}" is not one of your subagents — pass the ids background dispatches returned (see list_agents)`,
          );
        }
      }
      // Any already-settled child returns immediately (same semantics
      // as wait_subagent's pre-settled path).
      for (const id of ids) {
        if (ctx.agents.get(id) === undefined) {
          return { status: "settled", subagent_id: id, stop_reason: "unknown" };
        }
      }

      const idSet = new Set(ids);
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
          if (info && typeof info.id === "string" && idSet.has(info.id)) {
            finish({
              status: "settled",
              subagent_id: info.id,
              stop_reason: info.stopReason ?? "unknown",
              closing_message:
                extractText(info.lastAssistantMessage) || lastSnippet(info.id) || "",
            });
          }
        };

        const onAbort = () => {
          finish({ status: "cancelled", subagent_id: ids[0] });
        };

        disposeEnd = ctx.on("subagent/end", onEnd);
        exec.signal.addEventListener("abort", onAbort);

        // Race-free re-check (same synchronous-block argument as v1.0).
        for (const id of ids) {
          if (ctx.agents.get(id) === undefined) {
            finish({ status: "settled", subagent_id: id, stop_reason: "unknown" });
            return;
          }
        }

        if (timeoutMs && timeoutMs > 0) {
          timer = setTimeout(() => {
            // Report diagnostics for the least-recently-active child.
            let pick = ids[0];
            let oldest = Infinity;
            for (const id of ids) {
              const d = diagnosticsFor(id);
              const ts = d.observed ? Date.now() - d.lastActivityAgoMs : -1;
              if (ts < oldest) {
                oldest = ts;
                pick = id;
              }
            }
            finish({ status: "timeout", subagent_id: pick, diagnostics: diagnosticsFor(pick) });
          }, timeoutMs);
        }
      });
    },
  });
}

export { defineWaitSomeTool };
