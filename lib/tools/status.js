/**
 * dsh-wait-subagent — get_subagent_status tool definition (v1.1 probe,
 * renamed in v1.2; semantics, parameters, and output unchanged).
 *
 * Extracted verbatim from the v1.2 single-file implementation as part of
 * the zero-behavior-change split. `defineGetStatusTool(ctx)` is called
 * once per root agent from lib/index.js; `ctx` is the plugin-scoped
 * context (listChildren / agents.get) that the tool's execute closes over.
 */

import { defineTool } from "@deepseek-ai/dsh-tools";
import { diagnosticsFor } from "../activity.js";
import { statusSummary } from "../summaries.js";

/**
 * @param {import("@deepseek-ai/cordis").Context} ctx plugin-scoped context
 * @returns the registered-ready get_subagent_status tool definition
 */
function defineGetStatusTool(ctx) {
  return defineTool({
    name: "get_subagent_status",
    description:
      "Non-blocking liveness probe for one of your background subagents: reports whether it is still running, how long ago it last emitted activity, how many observed turns it has produced, and its most recent output snippet. " +
      "Use this to tell 'still working' from 'silently stalled' mid-flight — e.g. before deciding to keep waiting, interrupt, or re-dispatch. " +
      "Does not block and does not wait. If the child already settled, reports that. Observations come from this plugin's event listeners; 'not observed' is reported honestly (the child may predate the plugin load or have emitted nothing yet).",
    parameters: {
      subagent_id: {
        type: "string",
        required: true,
        description: "The subagent id returned by the background subagent dispatch.",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          status: { type: "string", required: true, enum: ["running", "settled"] },
          subagent_id: { type: "string", required: true },
          observed: { type: "boolean", required: true },
          lastActivityAgoMs: { type: "integer" },
          turnCount: { type: "integer" },
          recentOutputs: { type: "array", items: { type: "string" } },
        },
      },
      render: (_args, value) => [{ type: "text", text: statusSummary(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec.agent;
      if (!parent)
        throw new Error("get_subagent_status requires a calling agent (exec.agent was undefined)");
      const childId = args.subagent_id;

      const children = await ctx.subagents.listChildren(parent.id, exec.signal);
      if (!children.some((entry) => entry.id === childId)) {
        throw new Error(
          `get_subagent_status: "${childId}" is not one of your subagents — pass the id a background dispatch returned (see list_agents)`,
        );
      }
      if (ctx.agents.get(childId) === undefined) {
        return { status: "settled", subagent_id: childId, observed: false };
      }

      const d = diagnosticsFor(childId);
      if (!d.observed) {
        return { status: "running", subagent_id: childId, observed: false };
      }
      return {
        status: "running",
        subagent_id: childId,
        observed: true,
        lastActivityAgoMs: d.lastActivityAgoMs,
        turnCount: d.turnCount,
        recentOutputs: d.recentOutputs,
      };
    },
  });
}

export { defineGetStatusTool };
