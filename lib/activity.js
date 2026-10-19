/**
 * dsh-wait-subagent — activity tracking (v1.1 mechanism, module file since
 * the v1.2 single-file → multi-file split; behavior unchanged).
 *
 * Responsibility: per-child liveness bookkeeping for this plugin. A
 * module-level Map records the last observed activity, turn count, and
 * recent output snippets for each child id seen on the plugin's liveness
 * event subscriptions. State is a module singleton: every importer shares
 * the same Map (standard ESM semantics).
 *
 * Feeds `get_subagent_status` and the timeout diagnostics of the three
 * wait tools. Absence of observations is reported honestly ("not
 * observed") rather than guessed about.
 */

const MAX_SNIPPETS = 5;
const SNIPPET_CHARS = 200;
const MAX_TRACKED = 256;

/**
 * Per-child activity record. Keyed by child id.
 * @type {Map<string, {lastActivity:number, turnCount:number, recentOutputs:string[]}>}
 */
const activity = new Map();

/** Extract readable text from a content-block array or plain string. */
function extractText(blocksOrString) {
  if (typeof blocksOrString === "string") return blocksOrString;
  if (!Array.isArray(blocksOrString)) return "";
  return blocksOrString
    .filter((b) => b && typeof b === "object" && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
}

/** Feature-detect a child id from an event payload of unknown shape. */
function extractId(info) {
  if (!info || typeof info !== "object") return undefined;
  if (typeof info.id === "string") return info.id;
  if (typeof info.subagentId === "string") return info.subagentId;
  if (typeof info.agentId === "string") return info.agentId;
  if (info.agent && typeof info.agent === "object" && typeof info.agent.id === "string") {
    return info.agent.id;
  }
  return undefined;
}

/** Feature-detect a short assistant-output snippet from an unknown payload. */
function extractSnippet(info) {
  const raw =
    info?.lastAssistantMessage ??
    info?.message ??
    info?.text ??
    info?.blocks ??
    info?.content;
  const text = extractText(raw);
  return text ? text.slice(0, SNIPPET_CHARS) : "";
}

/** Record an activity touch (and optional snippet) for a child id. */
function noteActivity(id, snippet) {
  if (typeof id !== "string" || id.length === 0) return;
  let entry = activity.get(id);
  if (!entry) {
    if (activity.size >= MAX_TRACKED) {
      const oldest = activity.keys().next().value;
      if (oldest !== undefined) activity.delete(oldest);
    }
    entry = { lastActivity: 0, turnCount: 0, recentOutputs: [] };
    activity.set(id, entry);
  }
  entry.lastActivity = Date.now();
  if (snippet) {
    entry.turnCount += 1;
    entry.recentOutputs.push(snippet);
    if (entry.recentOutputs.length > MAX_SNIPPETS) entry.recentOutputs.shift();
  }
}

/** Diagnostics for one id; honest about "never observed". */
function diagnosticsFor(id) {
  const entry = activity.get(id);
  if (!entry || entry.lastActivity === 0) return { observed: false };
  return {
    observed: true,
    lastActivityAgoMs: Date.now() - entry.lastActivity,
    turnCount: entry.turnCount,
    recentOutputs: [...entry.recentOutputs],
  };
}

function lastSnippet(id) {
  const entry = activity.get(id);
  if (!entry || entry.recentOutputs.length === 0) return "";
  return entry.recentOutputs[entry.recentOutputs.length - 1];
}

function describeDiagnostics(d) {
  if (!d || d.observed !== true) {
    return "no activity observed by this plugin since it started (the child may predate the plugin, or it has emitted nothing — likely stalled at startup)";
  }
  const agoSec = Math.max(1, Math.round((d.lastActivityAgoMs ?? 0) / 1000));
  const tail = d.recentOutputs?.length
    ? ` latest output: "${d.recentOutputs[d.recentOutputs.length - 1]}"`
    : "";
  return `last activity ${agoSec}s ago across ${d.turnCount} observed turn(s)${tail}`;
}

export {
  MAX_SNIPPETS,
  SNIPPET_CHARS,
  MAX_TRACKED,
  extractText,
  extractId,
  extractSnippet,
  noteActivity,
  diagnosticsFor,
  lastSnippet,
  describeDiagnostics,
};
