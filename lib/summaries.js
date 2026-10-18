/**
 * dsh-wait-subagent — human-readable tool result summaries.
 *
 * Responsibility: the `render` text builders shared by the four tools.
 * Each function turns a tool result value into the single text block
 * shown to the model. Extracted verbatim from the v1.2 single-file
 * implementation (zero-behavior-change split): every string, including
 * punctuation and spacing, must stay byte-identical.
 */

import { describeDiagnostics } from "./activity.js";

/** Human-readable summary for wait_subagent / wait_some_subagent results. */
function summary(value) {
  if (value.status === "settled") {
    if (value.stop_reason === "unknown")
      return `Subagent ${value.subagent_id} had already settled before this call; its closing message was delivered separately as a settlement notice.`;
    const parts = [`Subagent ${value.subagent_id} settled: ${value.stop_reason}`];
    if (value.closing_message) parts.push(value.closing_message);
    else parts.push("(no closing message)");
    return parts.join("\n");
  }
  if (value.status === "timeout") {
    const parts = [`Timed out waiting for subagent ${value.subagent_id}; it may still be running.`];
    if (value.diagnostics) parts.push(describeDiagnostics(value.diagnostics));
    return parts.join("\n");
  }
  if (value.status === "cancelled")
    return `Wait for subagent ${value.subagent_id} was cancelled.`;
  return JSON.stringify(value);
}

/** Human-readable summary for wait_every_subagent (barrier) results. */
function summaryEvery(args, value) {
  if (value.status === "settled") {
    const results = value.results ?? [];
    const lines = results.map((r) => {
      const parts = [`Subagent ${r.subagent_id} settled: ${r.stop_reason}`];
      if (r.closing_message) parts.push(r.closing_message);
      else parts.push("(no closing message)");
      return parts.join("\n");
    });
    if (value.failed && value.failed.length > 0) {
      lines.push(`Failed: ${value.failed.join(", ")}`);
    } else {
      lines.push(`All ${results.length} subagents settled successfully.`);
    }
    return lines.join("\n");
  }
  if (value.status === "timeout") {
    const distinctIds = [
      ...new Set(
        (Array.isArray(args?.subagent_ids) ? args.subagent_ids : []).filter(
          (id) => typeof id === "string" && id.length > 0,
        ),
      ),
    ];
    const total = distinctIds.length;
    const stillRunning = value.pending?.length ?? 0;
    const settledCount = Math.max(0, total - stillRunning);
    const lines = [`Timed out: ${settledCount}/${total} settled, ${stillRunning} still running.`];
    for (const p of value.pending ?? []) {
      lines.push(`Subagent ${p.subagent_id}: ${describeDiagnostics(p)}`);
    }
    return lines.join("\n");
  }
  if (value.status === "cancelled")
    return "Wait for the listed subagents was cancelled.";
  return JSON.stringify(value);
}

function statusSummary(value) {
  if (value.status === "settled") {
    return `Subagent ${value.subagent_id} has already settled (before this call); no live status available.`;
  }
  if (value.observed) {
    return [
      `Subagent ${value.subagent_id} is running — last activity ${Math.max(
        1,
        Math.round((value.lastActivityAgoMs ?? 0) / 1000),
      )}s ago across ${value.turnCount} observed turn(s).`,
      ...(value.recentOutputs?.length
        ? [`Recent output: "${value.recentOutputs[value.recentOutputs.length - 1]}"`]
        : []),
    ].join("\n");
  }
  return `Subagent ${value.subagent_id} is running, but this plugin has not observed any activity from it (spawned before plugin load, or silent so far).`;
}

export { summary, summaryEvery, statusSummary };
