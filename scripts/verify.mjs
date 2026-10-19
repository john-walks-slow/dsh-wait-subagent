#!/usr/bin/env node
/**
 * dsh-wait-subagent v1.2 acceptance checks (no test framework, node >= 22).
 *
 * Run: node scripts/verify.mjs   (exit code 0 = all checks pass)
 *
 * Covers:
 *   1. Static assertions across every .js file under lib/ (recursive) plus
 *      package.json, README.md, README.zh-CN.md:
 *        - no legacy tool names (get_subagent_status's pre-rename spelling,
 *          wait_any_subagent) anywhere;
 *        - all four new tool names present somewhere in lib/ (directory-
 *          level existence, files may divide the mentions) and, per file,
 *          in package.json / README.md / README.zh-CN.md.
 *   1b. Line budget: every lib/ .js file is <= 400 lines (per-file counts
 *       are printed).
 *   2. package.json parses and version === "1.2.1".
 *   3. Dynamic import of lib/index.js: name / inject / apply exports.
 *   4. Mock functional tests through the real defineTool pipeline
 *      (wait_every_subagent settled / timeout / pre-settled,
 *       wait_some_subagent first-of-N, unknown-id rejection,
 *       get_subagent_status running/settled) — these assert behavior, so
 *       the multi-file split must keep them passing unchanged.
 *
 * If @deepseek-ai/dsh-tools fails to resolve, runs `npm install` in the
 * project root once, then retries the import.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { execSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// Tiny check harness
// ---------------------------------------------------------------------------

const checks = [];
async function check(name, fn) {
  try {
    await fn();
    checks.push({ name, pass: true });
    console.log(`PASS  ${name}`);
  } catch (err) {
    checks.push({ name, pass: false });
    console.log(`FAIL  ${name}`);
    console.log(`      ${err && err.stack ? err.stack.split("\n").slice(0, 4).join("\n      ") : String(err)}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function assertDeepEqual(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  assert(a === e, `${msg} — expected ${e}, got ${a}`);
}

// ---------------------------------------------------------------------------
// Mock DSH host (see brief: ctx.on returns disposer + sync emit; effect runs
// fn synchronously; tools.register captures definitions; listChildren and
// agents.get are controllable).
// ---------------------------------------------------------------------------

function makeMock({ children = [], live = [] } = {}) {
  const listeners = new Map();
  const registeredTools = [];
  const liveSet = new Set(live);

  const agent = {
    id: "root-agent-0",
    ctx: {
      effect(fn) {
        fn();
      },
      tools: {
        register(def) {
          registeredTools.push(def);
          return () => {};
        },
      },
    },
  };

  const ctx = {
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
      return () => {
        const arr = listeners.get(event);
        const i = arr.indexOf(handler);
        if (i >= 0) arr.splice(i, 1);
      };
    },
    emit(event, info) {
      for (const h of [...(listeners.get(event) ?? [])]) h(info);
    },
    agents: {
      roots: () => [agent],
      get: (id) => (liveSet.has(id) ? { id } : undefined),
    },
    subagents: {
      listChildren: async () => children.map((id) => ({ id })),
    },
    liveSet,
  };

  return { ctx, agent, registeredTools, liveSet };
}

/** Let the awaited listChildren continuation (listener attach) finish. */
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function toolByName(registeredTools, name) {
  const def = registeredTools.find((t) => t.name === name);
  assert(def !== undefined, `tool "${name}" was not registered`);
  return def;
}

function renderText(def, args, value) {
  const blocks = def.output.render(args, value);
  return blocks.map((b) => (b && typeof b.text === "string" ? b.text : "")).join("\n");
}

/** Editor-style line count: physical lines, trailing newline not a line. */
function lineCount(text) {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}

/** Every .js file under lib/, recursive, as slash-separated repo-relative paths. */
function collectLibJsFiles() {
  const libDir = path.join(root, "lib");
  return readdirSync(libDir, { recursive: true })
    .filter((rel) => rel.endsWith(".js") && statSync(path.join(libDir, rel)).isFile())
    .map((rel) => `lib/${rel.split(path.sep).join("/")}`)
    .sort();
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

async function main() {
  // -- 1. Static assertions -------------------------------------------------
  // Scan scope: every .js file under lib/ (recursive) + package.json +
  // README.md + README.zh-CN.md. Legacy names must appear nowhere; the four
  // new tool names must exist somewhere in lib/ as a whole (the split may
  // distribute mentions across files), and still per-file in package.json
  // and the two READMEs.
  const libJsFiles = collectLibJsFiles();
  const scannedFiles = [...libJsFiles, "package.json", "README.md", "README.zh-CN.md"];
  const texts = new Map(
    scannedFiles.map((f) => [f, readFileSync(path.join(root, ...f.split("/")), "utf8")]),
  );
  const legacyPatterns = [/(?<!get_)subagent_status/, /wait_any_subagent/];
  const newTools = ["wait_subagent", "get_subagent_status", "wait_some_subagent", "wait_every_subagent"];

  for (const [file, text] of texts) {
    for (const pattern of legacyPatterns) {
      await check(`static: ${file} has no legacy name matching ${pattern}`, () => {
        const m = text.match(pattern);
        assert(m === null, `legacy tool name ${m?.[0]} found in ${file}`);
      });
    }
  }

  const libCombined = libJsFiles.map((f) => texts.get(f)).join("\n");
  for (const tool of newTools) {
    await check(`static: lib/ (whole directory) mentions "${tool}"`, () => {
      assert(libCombined.includes(tool), `"${tool}" missing from the entire lib/ directory`);
    });
  }

  const nonLibFiles = scannedFiles.filter((f) => !f.startsWith("lib/"));
  for (const file of nonLibFiles) {
    for (const tool of newTools) {
      await check(`static: ${file} mentions "${tool}"`, () => {
        assert(texts.get(file).includes(tool), `"${tool}" missing from ${file}`);
      });
    }
  }

  // -- 1b. lib/ line budget (multi-file split) ------------------------------
  for (const file of libJsFiles) {
    await check(`line count: ${file} <= 400 lines`, () => {
      const n = lineCount(texts.get(file));
      console.log(`      ${file}: ${n} lines`);
      assert(n <= 400, `${file} has ${n} lines — exceeds the 400-line cap`);
    });
  }

  // -- 2. package.json -------------------------------------------------------
  let pkg;
  await check("package.json parses; version === 1.2.1", () => {
    pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    assert(pkg.version === "1.2.1", `version is ${pkg.version}, expected 1.2.1`);
  });

  await check("DEFECT-02 guard: dsh-tools is peer+dev only, never a runtime dep", () => {
    assert(!pkg.dependencies || !pkg.dependencies["@deepseek-ai/dsh-tools"], "dsh-tools must not appear in dependencies (DEFECT-02)");
    const peer = pkg.peerDependencies && pkg.peerDependencies["@deepseek-ai/dsh-tools"];
    assert(typeof peer === "string" && peer.includes("0.1.2-rc.1") && peer.includes("0.2.0-rc.2"), "peerDependencies missing/invalid dsh-tools range");
    assert(pkg.peerDependenciesMeta && pkg.peerDependenciesMeta["@deepseek-ai/dsh-tools"] && pkg.peerDependenciesMeta["@deepseek-ai/dsh-tools"].optional === true, "peerDependenciesMeta optional:true required");
    assert(pkg.devDependencies && pkg.devDependencies["@deepseek-ai/dsh-tools"] === "0.1.2-rc.1", "devDependencies dsh-tools must pin 0.1.2-rc.1");
  });

  // -- 3. Import the plugin ----------------------------------------------------
  let plugin;
  await check("import lib/index.js: name / inject / apply exports", async () => {
    const entry = pathToFileURL(path.join(root, "lib", "index.js")).href;
    try {
      plugin = await import(entry);
    } catch (err) {
      console.log("      initial import failed — running `npm install` and retrying once");
      execSync("npm install", { cwd: root, stdio: "inherit" });
      plugin = await import(entry);
    }
    assert(plugin.name === "dsh-wait-subagent", `name is ${plugin.name}`);
    assert(Array.isArray(plugin.inject), "inject is not an array");
    assert(typeof plugin.apply === "function", "apply is not a function");
  });

  if (!plugin) {
    console.log("\nplugin import failed — skipping mock functional checks");
    finish();
    return;
  }

  // -- 4. Mock functional tests ------------------------------------------------

  await check("wait_every_subagent: both end -> settled, ordered results + failed", async () => {
    const m = makeMock({ children: ["id-a", "id-b"], live: ["id-a", "id-b"] });
    plugin.apply(m.ctx);
    const def = toolByName(m.registeredTools, "wait_every_subagent");
    const args = { subagent_ids: ["id-a", "id-b"] };
    const signal = new AbortController().signal;
    const p = def.execute(args, { agent: m.agent, signal });
    await flush();
    m.ctx.emit("subagent/end", { id: "id-a", stopReason: "completed", lastAssistantMessage: "part A done" });
    m.ctx.emit("subagent/end", { id: "id-b", stopReason: "error", lastAssistantMessage: "boom: build failed" });
    const value = await p;
    assert(value.status === "settled", `status is ${value.status}`);
    assert(Array.isArray(value.results) && value.results.length === 2, "results must hold both ids");
    assertDeepEqual(value.results[0], { subagent_id: "id-a", stop_reason: "completed", closing_message: "part A done" }, "results[0]");
    assert(value.results[1].subagent_id === "id-b" && value.results[1].stop_reason === "error", "results[1] must be id-b/error");
    assertDeepEqual(value.failed, ["id-b"], "failed");
    const text = renderText(def, args, value);
    assert(text.includes("error"), "render text must mention the error stop_reason");
  });

  await check("wait_every_subagent: timeout -> pending carries id-b with observed field", async () => {
    const m = makeMock({ children: ["id-a", "id-b"], live: ["id-a", "id-b"] });
    plugin.apply(m.ctx);
    const def = toolByName(m.registeredTools, "wait_every_subagent");
    const args = { subagent_ids: ["id-a", "id-b"], timeout_ms: 300 };
    const signal = new AbortController().signal;
    const p = def.execute(args, { agent: m.agent, signal });
    await flush();
    m.ctx.emit("subagent/end", { id: "id-a", stopReason: "completed", lastAssistantMessage: "only A finished" });
    const value = await p;
    assert(value.status === "timeout", `status is ${value.status}`);
    assert(Array.isArray(value.pending) && value.pending.length === 1, "pending must list exactly the still-running id");
    assert(value.pending[0].subagent_id === "id-b", "pending must be id-b");
    assert(typeof value.pending[0].observed === "boolean", "pending entry must carry an observed field");
  });

  await check("wait_every_subagent: pre-settled children -> immediate settled with stop_reason unknown", async () => {
    const m = makeMock({ children: ["id-a", "id-b"], live: [] });
    plugin.apply(m.ctx);
    const def = toolByName(m.registeredTools, "wait_every_subagent");
    const args = { subagent_ids: ["id-a", "id-b"] };
    const signal = new AbortController().signal;
    const value = await def.execute(args, { agent: m.agent, signal });
    assert(value.status === "settled", `status is ${value.status}`);
    assert(value.results.length === 2, "both children must be reported");
    assert(value.results[0].subagent_id === "id-a" && value.results[0].stop_reason === "unknown", "id-a must be unknown/pre-settled");
    assert(value.results[1].subagent_id === "id-b" && value.results[1].stop_reason === "unknown", "id-b must be unknown/pre-settled");
    assertDeepEqual(value.failed, ["id-a", "id-b"], "failed");
  });

  await check("wait_some_subagent: first-of-N kept — emits id-b first -> resolves id-b", async () => {
    const m = makeMock({ children: ["id-a", "id-b"], live: ["id-a", "id-b"] });
    plugin.apply(m.ctx);
    const def = toolByName(m.registeredTools, "wait_some_subagent");
    const args = { subagent_ids: ["id-a", "id-b"] };
    const signal = new AbortController().signal;
    const p = def.execute(args, { agent: m.agent, signal });
    await flush();
    m.ctx.emit("subagent/end", { id: "id-b", stopReason: "completed", lastAssistantMessage: "B finished first" });
    const value = await p;
    assert(value.status === "settled", `status is ${value.status}`);
    assert(value.subagent_id === "id-b", `"any" semantics broken: resolved ${value.subagent_id}`);
  });

  await check("unknown ids: wait_some_subagent and wait_every_subagent both reject", async () => {
    for (const toolName of ["wait_some_subagent", "wait_every_subagent"]) {
      const m = makeMock({ children: ["id-a", "id-b"], live: ["id-a", "id-b"] });
      plugin.apply(m.ctx);
      const def = toolByName(m.registeredTools, toolName);
      const args = { subagent_ids: ["id-a", "id-not-mine"] };
      let rejected = false;
      try {
        await def.execute(args, { agent: m.agent, signal: new AbortController().signal });
      } catch {
        rejected = true;
      }
      assert(rejected, `${toolName} did not reject an unknown id`);
    }
  });

  await check("get_subagent_status: running+unobserved and settled paths", async () => {
    const m = makeMock({ children: ["id-a", "id-b"], live: ["id-a", "id-b"] });
    plugin.apply(m.ctx);
    const def = toolByName(m.registeredTools, "get_subagent_status");
    const signal = new AbortController().signal;
    const running = await def.execute({ subagent_id: "id-a" }, { agent: m.agent, signal });
    assertDeepEqual(running, { status: "running", subagent_id: "id-a", observed: false }, "live child");
    m.liveSet.delete("id-a"); // child settled -> removed from the live registry
    const settled = await def.execute({ subagent_id: "id-a" }, { agent: m.agent, signal });
    assertDeepEqual(settled, { status: "settled", subagent_id: "id-a", observed: false }, "settled child");
  });

  finish();
}

function finish() {
  const failed = checks.filter((c) => !c.pass);
  console.log("\n----------------------------------------------------------");
  console.log(`${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length > 0) {
    console.log(`FAILED: ${failed.map((c) => c.name).join(" | ")}`);
    process.exit(1);
  }
  console.log("ALL CHECKS PASSED");
  process.exit(0);
}

main().catch((err) => {
  console.error(`verify script crashed: ${err?.stack ?? err}`);
  process.exit(1);
});
