#!/usr/bin/env node
/**
 * Isolated regression harness for the 自动审批 / 自动审查 mode crossover.
 *
 * Runs the SHIPPED code — the real `Service.init` body, the real
 * `permission/preset` listener closure, the real `_enableCore` /
 * `_switchCore` / `_disable`, and the real `approval/request` +
 * `tools/pre-execute` claim guards — against a recording mock ctx. No DSH
 * composition, no network, no disk, no Jev.
 *
 * Why a harness and not just `node --check`: the crossover shipped because the
 * preset listener guarded on `_enabled.has(session.id)` ("is ANY mode on?")
 * where it needed `entry.mode` ("is THIS mode on?"). A test that re-implements
 * the guard would only ever prove the copy, so this drives the real closures.
 *
 * The two invariants under test:
 *   1. Selecting the other preset in /permission REWRITES the mode, so a
 *      session left in 自动审查 stops being claimed by tools/pre-execute.
 *   2. A mode switch never corrupts the restore point captured at first
 *      enable — `_disable` must return the session to the user's OWN knobs.
 */

import { Service } from "@deepseek-ai/cordis";
import { AgentApprovalService } from "../index.js";

const PRESET_APPROVAL = "agent-approval";
const PRESET_REVIEW = "agent-review";
const WORKSPACE = "workspace-write";
const FULL = "danger-full-access";
const READ_ONLY = "read-only";

// ---- tiny assertion runner ---------------------------------------------------

let checks = 0;
let failures = 0;
function check(name, cond, detail = "") {
  checks += 1;
  if (cond) {
    console.log("ok   " + name);
  } else {
    failures += 1;
    console.log("FAIL " + name + (detail === "" ? "" : " — " + detail));
  }
}

function section(title) {
  console.log("\n# " + title);
}

// ---- mock world -------------------------------------------------------------

/** A session whose append() feeds straight back into its own log fold. */
function makeSession(id, log) {
  return {
    id,
    snapshotEvents: () => log,
    append: (type, data) => {
      log.push({ type, data });
    },
  };
}

const PRESET_TABLE = {
  "read-only": { sandbox: READ_ONLY, approval: "ask" },
  [WORKSPACE]: { sandbox: WORKSPACE, approval: "ask" },
  [PRESET_APPROVAL]: { sandbox: WORKSPACE, approval: "ask" },
  [PRESET_REVIEW]: { sandbox: FULL, approval: "ask" },
  "danger-full-access": { sandbox: FULL, approval: "never" },
};

/** Optional capability surfaces — inert stubs; init only touches these. */
function makeScope() {
  return {
    systemPrompt: { context: () => {} },
    commands: { register: () => {} },
    llm: {
      stream: () => {
        throw new Error("harness: unexpected LLM stream");
      },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: "", model: "" }) },
    sessionTitle: { get: () => "" },
  };
}

function buildWorld() {
  const listeners = [];
  const policies = [];
  const presetWrites = [];
  const records = [];
  const commands = new Map();

  const presets = {
    names: Object.keys(PRESET_TABLE),
    resolve: (name) => PRESET_TABLE[name],
    set: (session, name) => {
      presetWrites.push({ sessionId: session.id, name });
    },
  };

  const ctx = {
    on(event, fn, opts) {
      listeners.push({ event, fn, opts });
      return () => {};
    },
    get(name) {
      return name === "permissionPresets" ? presets : undefined;
    },
    inject(_names, cb) {
      cb(makeScope());
    },
    agents: {
      get: (id) => ctx.__agents.get(id),
    },
    approval: {
      setPolicy(_agent, policy) {
        policies.push(policy);
      },
      overrideOf: () => undefined,
      config: { policy: "ask" },
    },
    timeout: () => new Promise(() => {}),
    __agents: new Map(),
  };

  const inst = Object.create(AgentApprovalService.prototype);
  inst.ctx = ctx;
  // State init() would have created; the log/persistence sides are irrelevant
  // here, so the side-effecting entry points are stubbed and recorded.
  // `_persistConfig` MUST be stubbed: the real one writes the user's actual
  // ~/.dsh config.json.
  inst._loadPersisted = async () => {};
  inst._persistConfig = () => {};
  inst._record = (session, entry) => records.push(entry);

  return { inst, ctx, listeners, policies, presetWrites, records, commands };
}

/** Fire the real `session/event` listener the way the host would. */
function emit(world, session, type, data) {
  const hit = world.listeners.find((l) => l.event === "session/event");
  if (hit === undefined) throw new Error("harness: no session/event listener");
  hit.fn(session, { type, data });
}

/** Fire the real `tools/pre-execute` listener; report whether we claimed it. */
async function preExecute(world, exec) {
  const hit = world.listeners.find((l) => l.event === "tools/pre-execute");
  if (hit === undefined) throw new Error("harness: no tools/pre-execute listener");
  let delegated = false;
  const next = async () => {
    delegated = true;
    return "delegated";
  };
  const verdict = await hit.fn(exec, next);
  return { claimed: delegated === false, verdict };
}

/** Fire the real `approval/request` listener; report whether we claimed it. */
async function approvalRequest(world, req) {
  const hit = world.listeners.find((l) => l.event === "approval/request");
  if (hit === undefined) throw new Error("harness: no approval/request listener");
  let delegated = false;
  const next = async () => {
    delegated = true;
    return "delegated";
  };
  const verdict = await hit.fn(req, next);
  return { claimed: delegated === false, verdict };
}

/** Fire the real `agent/created` listener (restart survival / re-arm). */
function agentCreated(world, agent) {
  const hit = world.listeners.find((l) => l.event === "agent/created");
  if (hit === undefined) throw new Error("harness: no agent/created listener");
  hit.fn({ agent });
}

function knobOf(log, type, field) {
  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i].type === type) return log[i].data[field];
  }
  return undefined;
}

function modeOf(world, session) {
  const entry = world.inst._enabled.get(session.id);
  return entry === undefined ? "off" : entry.mode;
}

/** A session parked on a pre-mode sandbox/approval/preset triple. */
function seedUserKnobs(log) {
  log.push({ type: "sandbox/mode", data: { mode: READ_ONLY } });
  log.push({ type: "approval/policy", data: { policy: "ask" } });
  log.push({ type: "permission/preset", data: { preset: "read-only" } });
}

async function main() {
  // ---- the reported symptom ------------------------------------------------

  section("review → 自动审批 via the /permission menu");
  {
    const w = buildWorld();
    await AgentApprovalService.prototype[Service.init].call(w.inst);

    const log = [];
    seedUserKnobs(log);
    const session = makeSession("session-a", log);
    const agent = { session };
    w.ctx.__agents.set(session.id, agent);
    // Jev gate open, so 自动审查 is selectable.
    w.inst._jev = { apiKey: "test-key", endpoint: "e", model: "m", confidence: 0.5 };

    emit(w, session, "permission/preset", { preset: PRESET_REVIEW });
    check("session enters 自动审查", modeOf(w, session) === "review", "mode=" + modeOf(w, session));
    check(
      "自动审查 pins Full access",
      knobOf(log, "sandbox/mode", "mode") === FULL,
      "sandbox=" + knobOf(log, "sandbox/mode", "mode"),
    );

    // The user now picks 自动审批 in the same session.
    emit(w, session, "permission/preset", { preset: PRESET_APPROVAL });
    check(
      "selecting 自动审批 REWRITES the mode to escalation",
      modeOf(w, session) === "escalation",
      "mode=" + modeOf(w, session),
    );

    // The symptom the user actually felt: tools were still being claimed.
    w.inst._reviewCall = async () => {
      throw new Error("harness: review judge must not run for an escalation session");
    };
    const exec = { agent, name: "read", parent: undefined, arguments: {} };
    const pe = await preExecute(w, exec);
    check(
      "tools/pre-execute no longer intercepts after the switch",
      pe.claimed === false,
      "still claimed by the per-call reviewer",
    );
    check("workspace-write base re-pinned", knobOf(log, "sandbox/mode", "mode") === WORKSPACE);
  }

  // ---- restore point must survive a mode switch ----------------------------

  section("mode switch does not corrupt the restore point");
  {
    const w = buildWorld();
    await AgentApprovalService.prototype[Service.init].call(w.inst);
    w.inst._jev = { apiKey: "k", endpoint: "e", model: "m", confidence: 0.5 };

    const log = [];
    seedUserKnobs(log);
    const session = makeSession("session-a", log);
    const agent = { session };
    w.ctx.__agents.set(session.id, agent);

    emit(w, session, "permission/preset", { preset: PRESET_REVIEW });
    emit(w, session, "permission/preset", { preset: PRESET_APPROVAL });

    const entry = w.inst._enabled.get(session.id);
    check(
      "prevSandbox is still the user's ORIGINAL (read-only), not Full access",
      entry.prevSandbox === READ_ONLY,
      "prevSandbox=" + entry.prevSandbox,
    );
    check("prevApproval preserved", entry.prevApproval === "ask", "prevApproval=" + entry.prevApproval);
    check("prevPreset preserved", entry.prevPreset === "read-only", "prevPreset=" + entry.prevPreset);

    w.inst._disable(agent, true);
    check(
      "_disable restores the user's own sandbox, not Full access",
      knobOf(log, "sandbox/mode", "mode") === READ_ONLY,
      "restored=" + knobOf(log, "sandbox/mode", "mode"),
    );
    check("mode fully cleared", modeOf(w, session) === "off");
  }

  // ---- the two claimers must not both hold one session ---------------------

  section("自动审查 and escalation never claim the same session");
  {
    const w = buildWorld();
    await AgentApprovalService.prototype[Service.init].call(w.inst);
    w.inst._judge = async () => "allowed-once";
    w.inst._reviewCall = async () => ({ kind: "deny", info: { name: "x" } });

    const log = [];
    const session = makeSession("session-a", log);
    const agent = { session };
    w.ctx.__agents.set(session.id, agent);
    const signal = new AbortController().signal;

    // --- in 自动审查 ---
    w.inst._enabled.set(session.id, {
      prevSandbox: READ_ONLY,
      prevApproval: "ask",
      prevPreset: "read-only",
      mode: "review",
    });
    const reqReview = await approvalRequest(w, { agent, toolName: "pwsh", callId: "c1", reason: "r", signal });
    check(
      "approval/request DELEGATES in 自动审查 (no second judge)",
      reqReview.claimed === false,
      "escalation judge claimed a review session",
    );
    const peReview = await preExecute(w, { agent, name: "pwsh", parent: undefined, arguments: {} });
    check("tools/pre-execute still claims in 自动审查", peReview.claimed === true);

    // --- in 自动审批 ---
    w.inst._enabled.set(session.id, {
      prevSandbox: READ_ONLY,
      prevApproval: "ask",
      prevPreset: "read-only",
      mode: "escalation",
    });
    const peEsc = await preExecute(w, { agent, name: "pwsh", parent: undefined, arguments: {} });
    check("tools/pre-execute DELEGATES in 自动审批 (per-call gate is off)", peEsc.claimed === false);
    const reqEsc = await approvalRequest(w, { agent, toolName: "pwsh", callId: "c1", reason: "r", signal });
    check("approval/request still claims in 自动审批", reqEsc.claimed === true);
  }

  // ---- the commands are symmetric with the menu -----------------------------

  section("/agent-approval and /agent-review switch modes both ways");
  {
    const w = buildWorld();
    await AgentApprovalService.prototype[Service.init].call(w.inst);
    w.inst._jev = { apiKey: "k", endpoint: "e", model: "m", confidence: 0.5 };

    const log = [];
    seedUserKnobs(log);
    const session = makeSession("session-a", log);
    const agent = { session };
    w.ctx.__agents.set(session.id, agent);

    w.inst._enableCore(session, agent, "review");
    const msgOn = w.inst._enable(agent, true);
    check("/agent-approval on switches out of 自动审查", modeOf(w, session) === "escalation", msgOn);
    check("its reply is not a false 'already ON'", !/already ON/.test(msgOn), msgOn);

    const msgReview = w.inst._setReviewEnabled(agent, true);
    check("/agent-review on switches into 自动审查", modeOf(w, session) === "review", msgReview);
    check("its reply is not a dead end", !/switch modes through/.test(msgReview), msgReview);

    // A repeat request for the mode that is already on stays idempotent.
    check("repeat is idempotent", /already ON/.test(w.inst._setReviewEnabled(agent, true)));
    check("off clears the entry", /not ON/.test(w.inst._setReviewEnabled(agent, false)) === false);
    w.inst._disable(agent, true);
    check("disabled after off", modeOf(w, session) === "off");
  }

  // ---- the Jev gate still fail-closes --------------------------------------

  section("gate still bounces 自动审查 without a Jev key");
  {
    const w = buildWorld();
    await AgentApprovalService.prototype[Service.init].call(w.inst);
    w.inst._jev = { apiKey: "", endpoint: "e", model: "m", confidence: 0.5 };

    const log = [];
    seedUserKnobs(log);
    const session = makeSession("session-a", log);
    const agent = { session };
    w.ctx.__agents.set(session.id, agent);

    emit(w, session, "permission/preset", { preset: PRESET_REVIEW });
    check("自动审查 refused with no key", modeOf(w, session) !== "review", "mode=" + modeOf(w, session));
    check("gate recorded why", w.records.some((r) => r.model === "gate"), "no gate audit record");
    check("gate bounced to the 自动审批 preset", w.presetWrites.some((p) => p.name === PRESET_APPROVAL));
  }

  // ---- configuring Jev no longer drags new sessions into review ------------

  section("配置 Jev 只开门，不自动进审查（v1.10.1）");
  {
    const w = buildWorld();
    await AgentApprovalService.prototype[Service.init].call(w.inst);
    w.inst._jev = { apiKey: "", endpoint: "e", model: "m", confidence: 0.5 };

    // The exact action that used to arm everything: save a usable Jev key.
    const saved = await w.inst.setJevConfig({ apiKey: "test-key" });
    check("setJevConfig reports the gate open", saved.value.reviewAvailable === true);
    check("setJevConfig no longer reports a review default", saved.value.reviewDefault === undefined);
    check("the Remote method is gone", typeof w.inst.setReviewDefault !== "function");

    const state = await w.inst.getState();
    check("getState no longer carries reviewDefault", state.value.reviewDefault === undefined);
    check("getState still reports the gate", state.value.reviewAvailable === true);

    // A brand-new session: empty log, no preset event, no user message.
    const log = [];
    const session = makeSession("session-new", log);
    const agent = { session };
    w.ctx.__agents.set(session.id, agent);
    agentCreated(w, agent);
    check("a fresh session does NOT auto-enter 自动审查", modeOf(w, session) === "off", "mode=" + modeOf(w, session));
    check("and no preset event was written behind the user's back", log.length === 0, "log=" + JSON.stringify(log));
  }

  // ---- restart survival still works ----------------------------------------

  section("agent/created still restores the mode the log actually records");
  {
    const w = buildWorld();
    await AgentApprovalService.prototype[Service.init].call(w.inst);
    w.inst._jev = { apiKey: "k", endpoint: "e", model: "m", confidence: 0.5 };

    // Folded 自动审查 → review (gate open).
    let log = [{ type: "permission/preset", data: { preset: PRESET_REVIEW } }];
    let session = makeSession("session-r1", log);
    let agent = { session };
    w.ctx.__agents.set(session.id, agent);
    agentCreated(w, agent);
    check("folded 自动审查 restores review", modeOf(w, session) === "review", "mode=" + modeOf(w, session));

    // Folded 自动审批 → escalation.
    log = [{ type: "permission/preset", data: { preset: PRESET_APPROVAL } }];
    session = makeSession("session-r2", log);
    agent = { session };
    w.ctx.__agents.set(session.id, agent);
    agentCreated(w, agent);
    check("folded 自动审批 restores escalation", modeOf(w, session) === "escalation", "mode=" + modeOf(w, session));

    // Folded 自动审查 with the gate closed → bounce to 自动审批, never bare.
    w.inst._jev.apiKey = "";
    log = [{ type: "permission/preset", data: { preset: PRESET_REVIEW } }];
    session = makeSession("session-r3", log);
    agent = { session };
    w.ctx.__agents.set(session.id, agent);
    agentCreated(w, agent);
    check("folded 自动审查 without a key does not restore review", modeOf(w, session) !== "review", "mode=" + modeOf(w, session));
  }

  // ---- review scope: only write / execute / transmit tools are judged -------

  section("审查范围只覆盖 bash/pwsh/write/edit/str_replace_editor/mcp__*");
  {
    const w = buildWorld();
    await AgentApprovalService.prototype[Service.init].call(w.inst);

    const log = [];
    const session = makeSession("session-scope", log);
    const agent = { session };
    w.ctx.__agents.set(session.id, agent);
    w.inst._enabled.set(session.id, {
      prevSandbox: READ_ONLY,
      prevApproval: "ask",
      prevPreset: "read-only",
      mode: "review",
    });
    w.inst._reviewCall = async () => ({ kind: "deny", info: { name: "AgentReviewDeniedError" } });

    const probed = [
      "bash",
      "pwsh",
      "write",
      "edit",
      "str_replace_editor",
      "mcp__github__create_issue",
      "read",
      "read_image",
      "glob",
      "grep",
      "web_search",
      "web_fetch",
      "todo_write",
      "present",
      "ask_user_question",
      "cordis_inspect_list",
      "job_list",
      "list_subagent_models",
      "list_mcp_resources",
      // third-party plugin tools: never reviewed, by user ruling — plugins
      // add and drop tools at will, so an allowlist can never track them.
      "dsh_im_return_file",
      "ralph",
      "schedule_create",
      "mcp_bogus__tool",
      "notbash",
      "rewrite",
    ];
    const judged = [];
    const skipped = [];
    for (const name of probed) {
      const r = await preExecute(w, { agent, name, parent: undefined, arguments: {} });
      (r.claimed ? judged : skipped).push(name);
    }

    const expectedJudged = [
      "bash",
      "pwsh",
      "write",
      "edit",
      "str_replace_editor",
      "mcp__github__create_issue",
    ];
    check(
      "exactly the write/exec/transmit tools are judged",
      JSON.stringify(judged) === JSON.stringify(expectedJudged),
      "judged=" + JSON.stringify(judged),
    );
    check("reads are all skipped", !judged.includes("read") && !judged.includes("glob"), "judged=" + JSON.stringify(judged));
    check(
      "a near-miss name is not judged (mcp__ is two underscores)",
      !judged.includes("mcp_bogus__tool") && !judged.includes("notbash") && !judged.includes("rewrite"),
      "skipped=" + JSON.stringify(skipped),
    );
    check(
      "third-party plugin tools are never judged",
      !judged.includes("dsh_im_return_file") && !judged.includes("ralph") && !judged.includes("schedule_create"),
      "judged=" + JSON.stringify(judged),
    );
    check(
      "every probed tool is accounted for (judged + skipped = probed)",
      judged.length + skipped.length === probed.length,
      judged.length + " + " + skipped.length + " != " + probed.length,
    );

    // PTC: the outer transport stays unreviewed, its inner calls do not.
    const outer = await preExecute(w, { agent, name: "run_code", parent: undefined, arguments: {} });
    check("outer run_code transport still delegates", outer.claimed === false);
    const innerRead = await preExecute(w, { agent, name: "read", parent: "run_code", arguments: {} });
    check("PTC inner read delegates (out of scope)", innerRead.claimed === false);
    const innerEdit = await preExecute(w, { agent, name: "edit", parent: "run_code", arguments: {} });
    check("PTC inner edit is judged (in scope)", innerEdit.claimed === true);
  }

  console.log("\n" + (failures === 0 ? "all " + checks + " checks passed" : failures + " of " + checks + " checks FAILED"));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("harness error: " + (e && e.stack ? e.stack : String(e)));
  process.exit(1);
});
