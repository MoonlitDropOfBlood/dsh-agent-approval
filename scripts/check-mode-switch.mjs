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
 * The invariants under test:
 *   1. Selecting the other preset in /permission REWRITES the mode, so a
 *      session left in 自动审查 stops being claimed by tools/pre-execute.
 *   2. A mode switch never corrupts the restore point captured at first
 *      enable — `_disable` must return the session to the user's OWN knobs.
 *   3. A delegated child of a 自动审查 session is covered by the review AND
 *      SAYS so: the inherited identity is a standard `permission/preset`
 *      event (`agent-review` + the plugin's own `source` marker) that the
 *      permission menu's derive() keeps visible, while the child's
 *      danger-full-access + never knobs stay exactly as the host pinned
 *      them. The marker is durable (it restores the coverage after a
 *      restart, even with the ancestor gone), it is written only once, and
 *      a LATER explicit preset choice still wins over it.
 */

import { readFileSync } from "node:fs";
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

/** The world whose session/event listener a freshly created session feeds. */
let activeWorld = null;

/**
 * A session whose append() feeds straight back into its own log fold AND
 * dispatches the appended event to the plugin's session/event listener.
 *
 * The host commits an appended event to the durable log FIRST and then
 * notifies every observer, so the plugin's OWN appends (the inherited-review
 * marker, the knob writes of a mode switch) must reach its preset listener
 * exactly like the host's appends do. Without that dispatch the harness
 * would test a plugin that never sees its own writes.
 */
function makeSession(id, log, header, world) {
  const owner = world === undefined ? activeWorld : world;
  const session = {
    id,
    header: header === undefined ? undefined : header,
    snapshotEvents: () => log,
    append: (type, data) => {
      log.push({ type, data });
      if (owner === null) return;
      const hit = owner.listeners.find((l) => l.event === "session/event");
      if (hit === undefined) return;
      hit.fn(session, { type, data });
    },
  };
  return session;
}

const PRESET_TABLE = {
  "read-only": { sandbox: READ_ONLY, approval: "ask" },
  [WORKSPACE]: { sandbox: WORKSPACE, approval: "ask" },
  [PRESET_APPROVAL]: { sandbox: WORKSPACE, approval: "ask" },
  [PRESET_REVIEW]: { sandbox: FULL, approval: "ask" },
  "danger-full-access": { sandbox: FULL, approval: "never" },
};

/** The host's answer when no configured preset matches the knob state. */
const CUSTOM_PRESET = "custom";

// ---- the host's preset derivation ------------------------------------------
// The host resolves the DISPLAYED preset from the folded knob state: the
// last recorded `permission/preset` identity wins while its bundle still
// matches, otherwise the first configured entry whose bundle matches wins,
// and "custom" when nothing matches. The plugin wraps this derivation to
// display the inherited review identity, so the mock has to reproduce the
// real mathematics — a wrapper tested against a fiction proves nothing.

function officialDerive(state) {
  const sandbox = state.sandbox ?? WORKSPACE;
  const approval = state.approval ?? "ask";
  const matches = (spec) => spec.sandbox === sandbox && spec.approval === approval;
  if (state.preset !== null && state.preset !== undefined) {
    const spec = PRESET_TABLE[state.preset];
    if (spec !== undefined && matches(spec)) return state.preset;
  }
  for (const name of Object.keys(PRESET_TABLE)) {
    const spec = PRESET_TABLE[name];
    if (matches(spec)) return name;
  }
  return CUSTOM_PRESET;
}

/** Fold one session's log into the knob state the host's projection keeps. */
function foldPermissionState(session) {
  const events = typeof session.snapshotEvents === "function" ? session.snapshotEvents() : [];
  let preset = null;
  let sandbox = null;
  let approval = null;
  for (const event of events) {
    if (!event || !event.data) continue;
    if (event.type === "permission/preset") preset = event.data.preset;
    else if (event.type === "sandbox/mode") sandbox = event.data.mode;
    else if (event.type === "approval/policy") approval = event.data.policy;
  }
  const state = { preset, sandbox, approval, seeded: false };
  // The session handle is not part of the host's KnobState. The mock carries
  // it (a wrapper may need to recognise its own inherited identity) without
  // letting it leak into shape comparisons.
  Object.defineProperty(state, "session", { value: session, enumerable: false });
  return state;
}

/**
 * The exact wording of the inherited-review source marker belongs to
 * index.js. Read it from the shipped source so this regression tracks the
 * implementation instead of a copy that can silently drift. A constant whose
 * NAME says "inherited" wins; a constant whose VALUE mentions the inherited
 * review is the fallback; the documented wording is the last resort.
 */
function discoverInheritedSource() {
  const fallback = { value: "agent-approval/inherited-review", discovered: false };
  let src;
  try {
    src = readFileSync(new URL("../index.js", import.meta.url), "utf8");
  } catch (e) {
    return fallback;
  }
  const hits = [];
  const re = /\b([A-Z][A-Z0-9_]{2,})\s*=\s*["'`]([^"'`]+)["'`]/g;
  let m;
  while ((m = re.exec(src)) !== null) hits.push({ name: m[1], value: m[2] });
  const named = hits.filter((h) => /INHERIT/i.test(h.name));
  if (named.length > 0) {
    const preferred = named.find((h) => /SOURCE|MARKER|ORIGIN|WHERE/.test(h.name)) || named[0];
    return { value: preferred.value, discovered: true };
  }
  const valued = hits.filter((h) => /inherit/i.test(h.value));
  if (valued.length > 0) return { value: valued[0].value, discovered: true };
  return fallback;
}

const INHERITED_SOURCE = discoverInheritedSource();

/** Whether a preset event is the plugin's own inherited-review marker. */
function isInheritedMarker(event) {
  if (!event || event.type !== "permission/preset" || !event.data) return false;
  if (event.data.preset !== PRESET_REVIEW) return false;
  const source = event.data.source;
  return typeof source === "string" && source !== "";
}

function markerEvents(log) {
  return log.filter(isInheritedMarker);
}

function lastPresetOf(log) {
  let name;
  for (const event of log) {
    if (event && event.type === "permission/preset" && event.data) name = event.data.preset;
  }
  return name;
}

function countEvents(log, type) {
  let n = 0;
  for (const event of log) if (event && event.type === type) n += 1;
  return n;
}

/**
 * The marker must carry a source that identifies the plugin's own inherited
 * review. When the implementation's constant was found in index.js the check
 * is exact; otherwise it falls back to the shipped wording's shape.
 */
function isInheritedSource(source) {
  if (typeof source !== "string" || source === "") return false;
  if (INHERITED_SOURCE.discovered) return source === INHERITED_SOURCE.value;
  return /inherit|child|review/i.test(source);
}

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
  const contexts = [];
  const effects = [];

  // The host's permission-presets service. `derive` mirrors the host's own
  // state matching, `stateOf` folds the session's durable log the way the
  // host's permission projection folds it, and `current` resolves a session
  // through `derive` — so a wrapper installed on either one is exercised
  // through the same path the host uses.
  const presets = {
    names: Object.keys(PRESET_TABLE),
    resolve: (name) => PRESET_TABLE[name],
    set: (session, name) => {
      presetWrites.push({ sessionId: session.id, name });
    },
    derive(state) {
      return officialDerive(state);
    },
    current(session) {
      return this.derive(this.stateOf(session), session);
    },
    stateOf(session) {
      return foldPermissionState(session);
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
    inject(names, cb) {
      const scope = makeScope();
      // Capture the model-facing context registrations (the review-mode
      // notice the plugin injects per session).
      scope.systemPrompt = { context: (entry) => contexts.push(entry) };
      // Capture the command registrations so the harness can invoke the
      // REAL handlers (e.g. the no-argument status reply of /agent-review
      // and /agent-approval) instead of re-implementing them.
      scope.commands = { register: (definition) => commands.set(definition.name, definition) };
      // The preset service is a composed dependency: hand the very same
      // service object over, so a wrapper installed through injection is the
      // one `ctx.get("permissionPresets")` returns.
      if (Array.isArray(names) && names.includes("permissionPresets")) {
        scope.permissionPresets = presets;
      }
      cb(scope);
    },
    effect(execute, label) {
      const disposer = typeof execute === "function" ? execute() : undefined;
      const record = { label, disposer };
      effects.push(record);
      return {
        dispose() {
          if (typeof record.disposer === "function") record.disposer();
        },
      };
    },
    agents: {
      get: (id) => ctx.__agents.get(id),
      list: () => Array.from(ctx.__agents.values()),
    },
    approval: {
      setPolicy(agent, policy) {
        policies.push({
          agentId: agent && agent.session ? agent.session.id : undefined,
          policy,
        });
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

  const world = {
    inst,
    ctx,
    listeners,
    policies,
    presetWrites,
    records,
    commands,
    contexts,
    effects,
    presets,
  };
  // Sessions created from here on belong to this world (see makeSession).
  activeWorld = world;
  return world;
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

/**
 * Invoke a registered command's REAL handler with the given raw input and
 * return its reply. The handler is the shipped one — the harness never
 * re-implements a status reply.
 */
function runCommand(w, name, rawInput, agent) {
  const def = w.commands.get(name);
  if (def === undefined) throw new Error("harness: command not registered: " + name);
  return def.handler({ rawInput, agent });
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

/**
 * A parent session whose user picked 自动审查 in the permission menu, with
 * its agent registered in the world.
 *
 * The host appends the selection to the durable log BEFORE it notifies the
 * observers, and the plugin's listener reads the log — so the event is put in
 * the log first, exactly like the host does it.
 */
function seedReviewedParent(w, id = "session-parent") {
  const parentLog = [];
  seedUserKnobs(parentLog);
  const parent = makeSession(id, parentLog, undefined, w);
  const parentAgent = { session: parent };
  w.ctx.__agents.set(parent.id, parentAgent);
  parentLog.push({ type: "permission/preset", data: { preset: PRESET_REVIEW } });
  emit(w, parent, "permission/preset", { preset: PRESET_REVIEW });
  return { parent, parentAgent, parentLog };
}

/**
 * A delegated child created through the host's REAL bootstrap sequence:
 * delegation pins danger-full-access + never, then the permission service
 * derives and appends the plain Full-access identity before the plugin's own
 * agent/created listener runs (the permission service's agent/created
 * listener is PREPENDED).
 */
function seedDelegatedChild(w, parent, id = "session-child", depth = 1) {
  const childLog = [
    { type: "sandbox/mode", data: { mode: FULL, source: "delegation" } },
    { type: "approval/policy", data: { policy: "never", source: "delegation" } },
  ];
  const child = makeSession(
    id,
    childLog,
    { parentSession: parent.id, origin: "subagent", delegationDepth: depth },
    w,
  );
  const childAgent = { session: child };
  w.ctx.__agents.set(child.id, childAgent);
  const bootstrap = { type: "permission/preset", data: { preset: FULL } };
  childLog.push(bootstrap);
  emit(w, child, bootstrap.type, bootstrap.data);
  return { child, childAgent, childLog };
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

  // ---- delegated children of a reviewed session inherit the review ---------
  // DSH's delegation seeds a child with the parent's sandbox override (Full
  // access in review mode) and pins its approval policy to "never" — but it
  // never carries our `agent-review` preset, so before v1.12.0 the child ran
  // machine-changing commands with Full access and NO judge.

  section("自动审查 覆盖被委派的子代理");
  {
    const w = buildWorld();
    await AgentApprovalService.prototype[Service.init].call(w.inst);
    w.inst._jev = { apiKey: "k", endpoint: "e", model: "m", confidence: 0.5 };

    const parentLog = [];
    seedUserKnobs(parentLog);
    const parent = makeSession("session-parent", parentLog);
    const parentAgent = { session: parent };
    w.ctx.__agents.set(parent.id, parentAgent);
    emit(w, parent, "permission/preset", { preset: PRESET_REVIEW });
    check("parent is in 自动审查", modeOf(w, parent) === "review", "mode=" + modeOf(w, parent));

    // The host delegates: the child inherits the parent's Full access and
    // never receives our preset.
    const childLog = [];
    const child = makeSession("session-child", childLog, {
      parentSession: parent.id,
      origin: "subagent",
      delegationDepth: 1,
    });
    const childAgent = { session: child };
    w.ctx.__agents.set(child.id, childAgent);
    agentCreated(w, childAgent);
    check("the child carries no preset of its own", modeOf(w, child) === "off", "mode=" + modeOf(w, child));

    let judged = 0;
    w.inst._reviewCall = async () => {
      judged += 1;
      return { kind: "deny", info: { name: "AgentReviewDeniedError" } };
    };
    const childBash = await preExecute(w, { agent: childAgent, name: "bash", parent: undefined, arguments: {} });
    check("the child's bash call IS judged", judged === 1 && childBash.claimed === true, "judged=" + judged);
    const childRead = await preExecute(w, { agent: childAgent, name: "read", parent: undefined, arguments: {} });
    check("the child's read still delegates (out of scope)", childRead.claimed === false, "judged=" + judged);
    const childEdit = await preExecute(w, { agent: childAgent, name: "edit", parent: undefined, arguments: {} });
    check("the child's edit IS judged", judged === 2 && childEdit.claimed === true, "judged=" + judged);

    // The model-facing notice must reach the child too, or it cannot make
    // sense of a denial.
    const notice = w.contexts.find((c) => c.name === "agent-approval:policy");
    check("the review notice is registered", notice !== undefined);
    const childText = notice.text({ agent: childAgent });
    check(
      "the child is told that its calls are reviewed",
      typeof childText === "string" && childText.indexOf("Per-call review mode") >= 0,
      "text=" + String(childText).slice(0, 60),
    );

    // The child's knobs are untouched: the host's delegation pin (approval
    // policy "never") must not be fought by the plugin.
    check("the child's sandbox was not rewritten by the plugin", knobOf(childLog, "sandbox/mode", "mode") === undefined);
  }

  section("宿主初始化的 Full-access 预设不会退出继承审查");
  {
    const w = buildWorld();
    await AgentApprovalService.prototype[Service.init].call(w.inst);
    w.inst._jev = { apiKey: "k", endpoint: "e", model: "m", confidence: 0.5 };

    const parentLog = [];
    seedUserKnobs(parentLog);
    const parent = makeSession("session-parent", parentLog);
    const parentAgent = { session: parent };
    w.ctx.__agents.set(parent.id, parentAgent);
    emit(w, parent, "permission/preset", { preset: PRESET_REVIEW });

    // Match the real 0.2.2 host sequence. Delegation first appends Full access
    // + never with source=delegation. Then permissionPresets' PREPENDED
    // agent/created listener sees no preset and derives danger-full-access,
    // appending that identity before this plugin's agent/created listener runs.
    // It is host initialization, NOT an explicit child opt-out.
    const childLog = [
      { type: "sandbox/mode", data: { mode: FULL, source: "delegation" } },
      { type: "approval/policy", data: { policy: "never", source: "delegation" } },
    ];
    const child = makeSession("session-child", childLog, {
      parentSession: parent.id,
      origin: "subagent",
      delegationDepth: 1,
    });
    const childAgent = { session: child };
    w.ctx.__agents.set(child.id, childAgent);
    const bootstrap = { type: "permission/preset", data: { preset: FULL } };
    childLog.push(bootstrap);
    emit(w, child, bootstrap.type, bootstrap.data);
    agentCreated(w, childAgent);

    check("the derived Full-access identity is not an explicit opt-out", !w.inst._reviewOptOut.has(child.id));
    check("the host-initialized child snapshots the inherited review", w.inst._reviewInherited.has(child.id));

    let judged = 0;
    w.inst._reviewCall = async () => {
      judged += 1;
      return { kind: "deny", info: { name: "AgentReviewDeniedError" } };
    };
    const pe = await preExecute(w, { agent: childAgent, name: "bash", parent: undefined, arguments: {} });
    check("the real host bootstrap sequence leaves the child judged", judged === 1 && pe.claimed === true, "judged=" + judged);

    // A later explicit Full-access selection may not append replacement knob
    // events (they already have those exact values). Only the FIRST preset
    // after the delegated knobs is bootstrap; this second one must survive
    // disposal + re-publication as an explicit opt-out.
    const explicit = { type: "permission/preset", data: { preset: FULL } };
    childLog.push(explicit);
    emit(w, child, explicit.type, explicit.data);
    check("a later explicit Full-access choice opts out immediately", w.inst._reviewOptOut.has(child.id));
    const explicitPe = await preExecute(w, { agent: childAgent, name: "bash", parent: undefined, arguments: {} });
    check("the later explicit choice stops review", judged === 1 && explicitPe.claimed === false, "judged=" + judged);

    const disposed = w.listeners.find((l) => l.event === "session/disposed");
    disposed.fn(child);
    agentCreated(w, childAgent);
    check("the later explicit choice survives re-publication", w.inst._reviewOptOut.has(child.id));
    check("re-publication does not resurrect inherited review", !w.inst._reviewInherited.has(child.id));
    const restoredPe = await preExecute(w, { agent: childAgent, name: "bash", parent: undefined, arguments: {} });
    check("the restored explicit choice still stops review", judged === 1 && restoredPe.claimed === false, "judged=" + judged);
  }

  section("自动审批 不传播给子代理（不递归审批）");
  {
    const w = buildWorld();
    await AgentApprovalService.prototype[Service.init].call(w.inst);
    w.inst._jev = { apiKey: "k", endpoint: "e", model: "m", confidence: 0.5 };

    const parentLog = [];
    seedUserKnobs(parentLog);
    const parent = makeSession("session-parent", parentLog);
    const parentAgent = { session: parent };
    w.ctx.__agents.set(parent.id, parentAgent);
    emit(w, parent, "permission/preset", { preset: PRESET_APPROVAL });
    check("parent is in 自动审批", modeOf(w, parent) === "escalation", "mode=" + modeOf(w, parent));

    const childLog = [];
    const child = makeSession("session-child", childLog, {
      parentSession: parent.id,
      origin: "subagent",
      delegationDepth: 1,
    });
    const childAgent = { session: child };
    w.ctx.__agents.set(child.id, childAgent);
    agentCreated(w, childAgent);
    check("the child has no escalation entry of its own", modeOf(w, child) === "off", "mode=" + modeOf(w, child));

    const notice = w.contexts.find((c) => c.name === "agent-approval:policy");
    const parentText = notice.text({ agent: parentAgent });
    check(
      "an ordinary 自动审批 session keeps its model-facing approval notice",
      typeof parentText === "string" && parentText.indexOf("Agent-approval mode is ON") >= 0,
      "text=" + String(parentText).slice(0, 60),
    );

    let judged = 0;
    w.inst._reviewCall = async () => {
      judged += 1;
      return { kind: "deny", info: { name: "AgentReviewDeniedError" } };
    };
    w.inst._judge = async () => {
      judged += 1;
      return "allowed-once";
    };
    const pe = await preExecute(w, { agent: childAgent, name: "bash", parent: undefined, arguments: {} });
    check("the child's call is NOT judged under 自动审批", judged === 0 && pe.claimed === false, "judged=" + judged);
    const ar = await approvalRequest(w, {
      agent: childAgent,
      toolName: "bash",
      callId: "call-child",
      reason: "escalate",
      signal: new AbortController().signal,
    });
    check("the child's escalation still delegates (no recursive approval)", judged === 0 && ar.claimed === false);
  }

  section("子代理显式选择 自动审批 时不继承审查");
  {
    const w = buildWorld();
    await AgentApprovalService.prototype[Service.init].call(w.inst);
    w.inst._jev = { apiKey: "k", endpoint: "e", model: "m", confidence: 0.5 };

    const parentLog = [];
    seedUserKnobs(parentLog);
    const parent = makeSession("session-parent", parentLog);
    const parentAgent = { session: parent };
    w.ctx.__agents.set(parent.id, parentAgent);
    emit(w, parent, "permission/preset", { preset: PRESET_REVIEW });

    const childLog = [];
    const child = makeSession("session-child", childLog, {
      parentSession: parent.id,
      origin: "subagent",
      delegationDepth: 1,
    });
    const childAgent = { session: child };
    w.ctx.__agents.set(child.id, childAgent);
    agentCreated(w, childAgent);

    // The child explicitly picks 自动审批 → its own mode wins.
    emit(w, child, "permission/preset", { preset: PRESET_APPROVAL });
    check("the child switched to 自动审批", modeOf(w, child) === "escalation", "mode=" + modeOf(w, child));

    let judged = 0;
    w.inst._reviewCall = async () => {
      judged += 1;
      return { kind: "deny", info: { name: "AgentReviewDeniedError" } };
    };
    const pe = await preExecute(w, { agent: childAgent, name: "bash", parent: undefined, arguments: {} });
    check("an explicit 自动审批 choice wins over the inherited review", judged === 0 && pe.claimed === false, "judged=" + judged);

    const notice = w.contexts.find((c) => c.name === "agent-approval:policy");
    const childText = notice.text({ agent: childAgent });
    check(
      "the explicit 自动审批 child keeps its approval notice",
      typeof childText === "string" && childText.indexOf("Agent-approval mode is ON") >= 0,
      "text=" + String(childText).slice(0, 60),
    );

    // The child's own escalation choice also stops review from leaking
    // THROUGH it to a new grandchild.
    const grandLog = [];
    const grand = makeSession("session-grand", grandLog, {
      parentSession: child.id,
      origin: "subagent",
      delegationDepth: 2,
    });
    const grandAgent = { session: grand };
    w.ctx.__agents.set(grand.id, grandAgent);
    agentCreated(w, grandAgent);
    const grandPe = await preExecute(w, { agent: grandAgent, name: "bash", parent: undefined, arguments: {} });
    check("an escalation ancestor stops the inherited review chain", judged === 0 && grandPe.claimed === false);
  }

  section("子代理显式选择其它预设会退出继承审查");
  {
    const w = buildWorld();
    await AgentApprovalService.prototype[Service.init].call(w.inst);
    w.inst._jev = { apiKey: "k", endpoint: "e", model: "m", confidence: 0.5 };

    const parentLog = [];
    seedUserKnobs(parentLog);
    const parent = makeSession("session-parent", parentLog);
    const parentAgent = { session: parent };
    w.ctx.__agents.set(parent.id, parentAgent);
    emit(w, parent, "permission/preset", { preset: PRESET_REVIEW });

    const childLog = [];
    const child = makeSession("session-child", childLog, {
      parentSession: parent.id,
      origin: "subagent",
      delegationDepth: 1,
    });
    const childAgent = { session: child };
    w.ctx.__agents.set(child.id, childAgent);
    agentCreated(w, childAgent);

    let judged = 0;
    w.inst._reviewCall = async () => {
      judged += 1;
      return { kind: "deny", info: { name: "AgentReviewDeniedError" } };
    };

    emit(w, child, "permission/preset", { preset: READ_ONLY });
    check("read-only records an explicit inheritance opt-out", w.inst._reviewOptOut.has(child.id));
    const readOnlyPe = await preExecute(w, { agent: childAgent, name: "bash", parent: undefined, arguments: {} });
    check("an explicit read-only choice beats the inherited review", judged === 0 && readOnlyPe.claimed === false);

    emit(w, child, "permission/preset", { preset: PRESET_REVIEW });
    check("selecting 自动审查 clears the opt-out", !w.inst._reviewOptOut.has(child.id));
    const reviewPe = await preExecute(w, { agent: childAgent, name: "bash", parent: undefined, arguments: {} });
    check("the child can explicitly re-enter review", judged === 1 && reviewPe.claimed === true);

    emit(w, child, "permission/preset", { preset: "danger-full-access" });
    check("danger-full-access also opts out of inherited review", w.inst._reviewOptOut.has(child.id));
    const fullPe = await preExecute(w, { agent: childAgent, name: "bash", parent: undefined, arguments: {} });
    check("an explicit Full-access choice beats the inherited review", judged === 1 && fullPe.claimed === false);

    const disposed = w.listeners.find((l) => l.event === "session/disposed");
    disposed.fn(child);
    check("disposal clears the opt-out", !w.inst._reviewOptOut.has(child.id));

    // Re-publication folds the durable danger-full-access preset and must
    // restore the opt-out rather than re-inheriting the live parent's review.
    childLog.push({ type: "permission/preset", data: { preset: "danger-full-access" } });
    agentCreated(w, childAgent);
    check("re-publication restores the explicit opt-out", w.inst._reviewOptOut.has(child.id));
    check("re-publication does not recreate the inheritance snapshot", !w.inst._reviewInherited.has(child.id));
    const restoredPe = await preExecute(w, { agent: childAgent, name: "bash", parent: undefined, arguments: {} });
    check("the restored explicit choice still beats inheritance", judged === 1 && restoredPe.claimed === false);
  }

  section("父会话结束后子代理仍然受审（创建时快照）");
  {
    const w = buildWorld();
    await AgentApprovalService.prototype[Service.init].call(w.inst);
    w.inst._jev = { apiKey: "k", endpoint: "e", model: "m", confidence: 0.5 };

    const parentLog = [];
    seedUserKnobs(parentLog);
    const parent = makeSession("session-parent", parentLog);
    const parentAgent = { session: parent };
    w.ctx.__agents.set(parent.id, parentAgent);
    emit(w, parent, "permission/preset", { preset: PRESET_REVIEW });

    const childLog = [];
    const child = makeSession("session-child", childLog, {
      parentSession: parent.id,
      origin: "subagent",
      delegationDepth: 1,
    });
    const childAgent = { session: child };
    w.ctx.__agents.set(child.id, childAgent);
    agentCreated(w, childAgent);
    check("the creation snapshot is recorded", w.inst._reviewInherited.has(child.id) === true);

    // The parent goes away (disposed) while the child keeps running.
    const disposed = w.listeners.find((l) => l.event === "session/disposed");
    disposed.fn(parent);
    check("the parent's entry is gone", w.inst._enabled.has(parent.id) === false);

    let judged = 0;
    w.inst._reviewCall = async () => {
      judged += 1;
      return { kind: "deny", info: { name: "AgentReviewDeniedError" } };
    };
    const pe = await preExecute(w, { agent: childAgent, name: "bash", parent: undefined, arguments: {} });
    check("the orphaned child is still judged", judged === 1 && pe.claimed === true, "judged=" + judged);

    // The orphaned child then delegates a NEW grandchild. Its inherited
    // review must be transitive even though the original parent is gone.
    const grandLog = [];
    const grand = makeSession("session-grand", grandLog, {
      parentSession: child.id,
      origin: "subagent",
      delegationDepth: 2,
    });
    const grandAgent = { session: grand };
    w.ctx.__agents.set(grand.id, grandAgent);
    agentCreated(w, grandAgent);
    check("the new grandchild snapshots the orphaned child's inherited review", w.inst._reviewInherited.has(grand.id));
    const grandPe = await preExecute(w, { agent: grandAgent, name: "bash", parent: undefined, arguments: {} });
    check("a grandchild created after the root was disposed is still judged", judged === 2 && grandPe.claimed === true);
  }

  section("父会话后进入自动审查时，子代理随之受审（实时链路）");
  {
    const w = buildWorld();
    await AgentApprovalService.prototype[Service.init].call(w.inst);
    w.inst._jev = { apiKey: "k", endpoint: "e", model: "m", confidence: 0.5 };

    const parentLog = [];
    seedUserKnobs(parentLog);
    const parent = makeSession("session-parent", parentLog);
    const parentAgent = { session: parent };
    w.ctx.__agents.set(parent.id, parentAgent);

    const childLog = [];
    const child = makeSession("session-child", childLog, {
      parentSession: parent.id,
      origin: "subagent",
      delegationDepth: 1,
    });
    const childAgent = { session: child };
    w.ctx.__agents.set(child.id, childAgent);
    agentCreated(w, childAgent);
    check("no inheritance while the parent is not reviewed", w.inst._reviewInherited.has(child.id) === false);

    let judged = 0;
    w.inst._reviewCall = async () => {
      judged += 1;
      return { kind: "deny", info: { name: "AgentReviewDeniedError" } };
    };
    const before = await preExecute(w, { agent: childAgent, name: "bash", parent: undefined, arguments: {} });
    check("the child is not judged while the parent is unreviewed", judged === 0 && before.claimed === false);

    // The parent switches to 自动审查 afterwards.
    emit(w, parent, "permission/preset", { preset: PRESET_REVIEW });
    check("entering review snapshots an already-created child before any call", w.inst._reviewInherited.has(child.id));
    const after = await preExecute(w, { agent: childAgent, name: "bash", parent: undefined, arguments: {} });
    check("the child is judged once the parent is reviewed", judged === 1 && after.claimed === true, "judged=" + judged);

    const disposed = w.listeners.find((l) => l.event === "session/disposed");
    disposed.fn(parent);
    const afterDisposal = await preExecute(w, { agent: childAgent, name: "bash", parent: undefined, arguments: {} });
    check("the late-covered child stays judged after the parent is disposed", judged === 2 && afterDisposal.claimed === true);
  }

  section("孙代理沿链路继承审查");
  {
    const w = buildWorld();
    await AgentApprovalService.prototype[Service.init].call(w.inst);
    w.inst._jev = { apiKey: "k", endpoint: "e", model: "m", confidence: 0.5 };

    const parentLog = [];
    seedUserKnobs(parentLog);
    const parent = makeSession("session-parent", parentLog);
    const parentAgent = { session: parent };
    w.ctx.__agents.set(parent.id, parentAgent);
    emit(w, parent, "permission/preset", { preset: PRESET_REVIEW });

    const childLog = [];
    const child = makeSession("session-child", childLog, {
      parentSession: parent.id,
      origin: "subagent",
      delegationDepth: 1,
    });
    const childAgent = { session: child };
    w.ctx.__agents.set(child.id, childAgent);
    agentCreated(w, childAgent);

    const grandLog = [];
    const grand = makeSession("session-grand", grandLog, {
      parentSession: child.id,
      origin: "subagent",
      delegationDepth: 2,
    });
    const grandAgent = { session: grand };
    w.ctx.__agents.set(grand.id, grandAgent);
    agentCreated(w, grandAgent);

    let judged = 0;
    w.inst._reviewCall = async () => {
      judged += 1;
      return { kind: "deny", info: { name: "AgentReviewDeniedError" } };
    };
    const pe = await preExecute(w, { agent: grandAgent, name: "bash", parent: undefined, arguments: {} });
    check("the grandchild is judged through the chain", judged === 1 && pe.claimed === true, "judged=" + judged);
  }

  // ---- the no-argument status replies must match the EFFECTIVE mode -------
  // An inherited review child has no own `_enabled` entry, so the replies
  // used to be computed from that entry alone: /agent-review said "OFF" for
  // a session whose calls are in fact judged, and /agent-approval said a
  // bare "OFF" instead of explaining that the session is in 自动审查.

  section("无参命令在继承子代理上不再回 OFF");
  {
    const w = buildWorld();
    await AgentApprovalService.prototype[Service.init].call(w.inst);
    w.inst._jev = { apiKey: "k", endpoint: "e", model: "m", confidence: 0.5 };

    const { parent, parentAgent } = seedReviewedParent(w);
    const { child, childAgent } = seedDelegatedChild(w, parent);
    agentCreated(w, childAgent);

    check("the inherited child carries no own mode entry", modeOf(w, child) === "off");
    check("the inherited child IS covered by the review", w.inst._reviewCovers(child) === true);

    // --- /agent-review on the inherited child ---
    const reviewReply = runCommand(w, "agent-review", "", childAgent);
    check(
      "inherited child: /agent-review does not answer OFF",
      typeof reviewReply.text === "string" && reviewReply.text.indexOf("OFF") < 0,
      reviewReply.text,
    );
    check(
      "inherited child: /agent-review answers ON",
      typeof reviewReply.text === "string" && reviewReply.text.indexOf("agent-review is ON") >= 0,
      reviewReply.text,
    );
    check(
      "inherited child: /agent-review says it is inherited",
      typeof reviewReply.text === "string" &&
        reviewReply.text.indexOf("inherited from an ancestor session") >= 0,
      reviewReply.text,
    );

    // --- /agent-approval on the inherited child ---
    const approvalReply = runCommand(w, "agent-approval", "", childAgent);
    check(
      "inherited child: /agent-approval is not a bare ON",
      typeof approvalReply.text === "string" && approvalReply.text.indexOf("agent-approval is ON") < 0,
      approvalReply.text,
    );
    check(
      "inherited child: /agent-approval explains 自动审查",
      typeof approvalReply.text === "string" &&
        approvalReply.text.indexOf("OFF (this session is in 自动审查 per-call review mode)") >= 0,
      approvalReply.text,
    );

    // --- an own review session (the parent) keeps its own wording ---
    const parentReview = runCommand(w, "agent-review", "", parentAgent);
    check(
      "own review session: /agent-review answers ON",
      typeof parentReview.text === "string" && parentReview.text.indexOf("agent-review is ON") >= 0,
      parentReview.text,
    );
    check(
      "own review session: /agent-review does not claim inheritance",
      typeof parentReview.text === "string" &&
        parentReview.text.indexOf("inherited from an ancestor session") < 0,
      parentReview.text,
    );
    const parentApproval = runCommand(w, "agent-approval", "", parentAgent);
    check(
      "own review session: /agent-approval explains 自动审查",
      typeof parentApproval.text === "string" &&
        parentApproval.text.indexOf("OFF (this session is in 自动审查 per-call review mode)") >= 0,
      parentApproval.text,
    );
  }

  section("自有 review / escalation 会话的无参回执不回退");
  {
    const w = buildWorld();
    await AgentApprovalService.prototype[Service.init].call(w.inst);
    w.inst._jev = { apiKey: "k", endpoint: "e", model: "m", confidence: 0.5 };

    // --- an own 自动审批 session ---
    const escLog = [];
    seedUserKnobs(escLog);
    const escSession = makeSession("session-escalation", escLog);
    const escAgent = { session: escSession };
    w.ctx.__agents.set(escSession.id, escAgent);
    emit(w, escSession, "permission/preset", { preset: PRESET_APPROVAL });
    check("the escalation session is in 自动审批", modeOf(w, escSession) === "escalation");

    const escApproval = runCommand(w, "agent-approval", "", escAgent);
    check(
      "own escalation session: /agent-approval answers ON",
      typeof escApproval.text === "string" && escApproval.text.indexOf("agent-approval is ON") >= 0,
      escApproval.text,
    );
    const escReview = runCommand(w, "agent-review", "", escAgent);
    check(
      "own escalation session: /agent-review answers OFF",
      typeof escReview.text === "string" && escReview.text.indexOf("agent-review is OFF") >= 0,
      escReview.text,
    );
    check(
      "own escalation session: /agent-review does not claim inheritance",
      typeof escReview.text === "string" &&
        escReview.text.indexOf("inherited from an ancestor session") < 0,
      escReview.text,
    );

    // --- an ordinary session with no mode at all ---
    const plainLog = [];
    const plainSession = makeSession("session-plain-cmd", plainLog);
    const plainAgent = { session: plainSession };
    w.ctx.__agents.set(plainSession.id, plainAgent);

    const plainApproval = runCommand(w, "agent-approval", "", plainAgent);
    check(
      "unreviewed session: /agent-approval answers plain OFF",
      typeof plainApproval.text === "string" &&
        plainApproval.text.indexOf("agent-approval is OFF for this session") >= 0,
      plainApproval.text,
    );
    const plainReview = runCommand(w, "agent-review", "", plainAgent);
    check(
      "unreviewed session: /agent-review answers OFF",
      typeof plainReview.text === "string" && plainReview.text.indexOf("agent-review is OFF") >= 0,
      plainReview.text,
    );

    // --- a child that explicitly opted out of the inherited review ---
    const { parent } = seedReviewedParent(w);
    const { child: optOut, childAgent: optOutAgent } = seedDelegatedChild(w, parent, "session-optout");
    agentCreated(w, optOutAgent);
    emit(w, optOut, "permission/preset", { preset: "danger-full-access" });
    check("the explicit Full-access choice opts the child out", w.inst._reviewOptOut.has(optOut.id));

    const optOutReview = runCommand(w, "agent-review", "", optOutAgent);
    check(
      "opted-out child: /agent-review answers OFF",
      typeof optOutReview.text === "string" && optOutReview.text.indexOf("agent-review is OFF") >= 0,
      optOutReview.text,
    );
    const optOutApproval = runCommand(w, "agent-approval", "", optOutAgent);
    check(
      "opted-out child: /agent-approval answers plain OFF",
      typeof optOutApproval.text === "string" &&
        optOutApproval.text.indexOf("agent-approval is OFF for this session") >= 0,
      optOutApproval.text,
    );
  }

  // ---- the inherited review is a STANDARD, DURABLE preset identity ---------
  // A delegated child of a 自动审查 session runs danger-full-access + never
  // (the host's delegation pin). The permission menu derives its entry from
  // those knob values, so without help the child would be reported as plain
  // "Full access" — a menu that contradicts the mode that actually covers
  // it. The plugin therefore records the inherited identity as a standard
  // `permission/preset` event and wraps the preset service's derive() so the
  // identity stays visible. The child's knobs are NOT touched: the marker
  // names the mode the child is covered by, it does not re-configure it.

  section("继承子代理写入标准 agent-review 标记（不改 Full+never 旋钮）");
  {
    const w = buildWorld();
    await AgentApprovalService.prototype[Service.init].call(w.inst);
    w.inst._jev = { apiKey: "k", endpoint: "e", model: "m", confidence: 0.5 };

    const { parent } = seedReviewedParent(w);
    const { child, childAgent, childLog } = seedDelegatedChild(w, parent);
    agentCreated(w, childAgent);

    const markers = markerEvents(childLog);
    check(
      "the inherited child records exactly one review marker",
      markers.length === 1,
      "markers=" + JSON.stringify(markers.map((m) => m.data)),
    );
    check(
      "the marker names the agent-review preset",
      markers.length === 1 && markers[0].data.preset === PRESET_REVIEW,
      "preset=" + (markers.length === 1 ? markers[0].data.preset : "(none)"),
    );
    check(
      "the marker carries the plugin's own inherited-review source",
      markers.length === 1 && isInheritedSource(markers[0].data.source),
      "source=" +
        (markers.length === 1 ? markers[0].data.source : "(none)") +
        " expected=" +
        INHERITED_SOURCE.value +
        " discovered=" +
        INHERITED_SOURCE.discovered,
    );
    check(
      "the marker is the child's effective preset identity",
      lastPresetOf(childLog) === PRESET_REVIEW,
      "last=" + lastPresetOf(childLog),
    );
    check(
      "the child's Full+never knobs are untouched by the plugin",
      countEvents(childLog, "sandbox/mode") === 1 && countEvents(childLog, "approval/policy") === 1,
      "knobs=" +
        JSON.stringify(
          childLog.filter((e) => e.type === "sandbox/mode" || e.type === "approval/policy"),
        ),
    );
    check(
      "the child's approval policy was never rewritten to ask",
      w.policies.every((p) => p.agentId !== child.id),
      "policies=" + JSON.stringify(w.policies),
    );
    check(
      "the inherited child keeps no own mode entry",
      modeOf(w, child) === "off",
      "mode=" + modeOf(w, child),
    );

    let judged = 0;
    w.inst._reviewCall = async () => {
      judged += 1;
      return { kind: "deny", info: { name: "AgentReviewDeniedError" } };
    };
    const pe = await preExecute(w, { agent: childAgent, name: "bash", parent: undefined, arguments: {} });
    check("the inherited child is judged", judged === 1 && pe.claimed === true, "judged=" + judged);
  }

  section("继承状态显示 agent-review；普通 Full+never 仍显示 danger-full-access");
  {
    const w = buildWorld();
    await AgentApprovalService.prototype[Service.init].call(w.inst);
    w.inst._jev = { apiKey: "k", endpoint: "e", model: "m", confidence: 0.5 };

    const { parent } = seedReviewedParent(w);
    const { child, childAgent } = seedDelegatedChild(w, parent);
    agentCreated(w, childAgent);

    check(
      "the inherited child's displayed preset is agent-review",
      w.presets.current(child) === PRESET_REVIEW,
      "displayed=" + w.presets.current(child),
    );
    check(
      "the reviewed parent still displays agent-review",
      w.presets.current(parent) === PRESET_REVIEW,
      "displayed=" + w.presets.current(parent),
    );

    // A plain Full access + never session with no preset identity at all.
    const plainLog = [
      { type: "sandbox/mode", data: { mode: FULL } },
      { type: "approval/policy", data: { policy: "never" } },
    ];
    const plain = makeSession("session-plain", plainLog, undefined, w);
    w.ctx.__agents.set(plain.id, { session: plain });
    check(
      "a plain Full+never session still displays danger-full-access",
      w.presets.current(plain) === "danger-full-access",
      "displayed=" + w.presets.current(plain),
    );

    // The same session with the explicit Full-access identity recorded.
    const explicitLog = plainLog.concat([
      { type: "permission/preset", data: { preset: "danger-full-access" } },
    ]);
    const explicit = makeSession("session-plain-2", explicitLog, undefined, w);
    w.ctx.__agents.set(explicit.id, { session: explicit });
    check(
      "an explicit Full-access identity still displays danger-full-access",
      w.presets.current(explicit) === "danger-full-access",
      "displayed=" + w.presets.current(explicit),
    );
  }

  section("冷恢复：凭持久化标记恢复审查，且不重复追加");
  {
    // The first world creates the inherited child and stamps the marker.
    const w1 = buildWorld();
    await AgentApprovalService.prototype[Service.init].call(w1.inst);
    w1.inst._jev = { apiKey: "k", endpoint: "e", model: "m", confidence: 0.5 };
    const { parent } = seedReviewedParent(w1);
    const { childAgent, childLog } = seedDelegatedChild(w1, parent);
    agentCreated(w1, childAgent);
    check(
      "the inherited child recorded a durable marker",
      markerEvents(childLog).length === 1,
      "markers=" + markerEvents(childLog).length,
    );

    // Restart: a fresh plugin instance, and the reviewed ancestor is NOT
    // live any more — only the durable marker can restore the coverage.
    const persisted = JSON.parse(JSON.stringify(childLog));
    const before = persisted.length;
    const w2 = buildWorld();
    await AgentApprovalService.prototype[Service.init].call(w2.inst);
    w2.inst._jev = { apiKey: "k", endpoint: "e", model: "m", confidence: 0.5 };
    const restored = makeSession(
      "session-child",
      persisted,
      { parentSession: parent.id, origin: "subagent", delegationDepth: 1 },
      w2,
    );
    const restoredAgent = { session: restored };
    w2.ctx.__agents.set(restored.id, restoredAgent);
    agentCreated(w2, restoredAgent);

    let judged = 0;
    w2.inst._reviewCall = async () => {
      judged += 1;
      return { kind: "deny", info: { name: "AgentReviewDeniedError" } };
    };
    const pe = await preExecute(w2, { agent: restoredAgent, name: "bash", parent: undefined, arguments: {} });
    check("the cold-restored child is judged again", judged === 1 && pe.claimed === true, "judged=" + judged);
    check(
      "the persisted marker is not appended twice",
      markerEvents(persisted).length === 1,
      "markers=" + markerEvents(persisted).length,
    );
    check(
      "the cold restore writes no new session event",
      persisted.length === before,
      "log grew by " + (persisted.length - before),
    );
    check(
      "the cold-restored child keeps no own mode entry",
      modeOf(w2, restored) === "off",
      "mode=" + modeOf(w2, restored),
    );
    check(
      "the cold-restored child's knobs are still Full+never",
      knobOf(persisted, "sandbox/mode", "mode") === FULL &&
        knobOf(persisted, "approval/policy", "policy") === "never",
      "knobs=" +
        JSON.stringify(
          persisted.filter((e) => e.type === "sandbox/mode" || e.type === "approval/policy"),
        ),
    );
    check(
      "the cold-restored child still displays agent-review",
      w2.presets.current(restored) === PRESET_REVIEW,
      "displayed=" + w2.presets.current(restored),
    );
  }

  section("继承后显式选择 Full/其它预设仍然退出，重发布不复活");
  {
    const w = buildWorld();
    await AgentApprovalService.prototype[Service.init].call(w.inst);
    w.inst._jev = { apiKey: "k", endpoint: "e", model: "m", confidence: 0.5 };

    const { parent } = seedReviewedParent(w);
    const { child, childAgent, childLog } = seedDelegatedChild(w, parent);
    agentCreated(w, childAgent);

    let judged = 0;
    w.inst._reviewCall = async () => {
      judged += 1;
      return { kind: "deny", info: { name: "AgentReviewDeniedError" } };
    };
    const inherited = await preExecute(w, { agent: childAgent, name: "bash", parent: undefined, arguments: {} });
    check("the inherited child starts out judged", judged === 1 && inherited.claimed === true, "judged=" + judged);

    // The child explicitly picks Full access.
    const explicitFull = { type: "permission/preset", data: { preset: "danger-full-access" } };
    childLog.push(explicitFull);
    emit(w, child, explicitFull.type, explicitFull.data);
    const afterFull = await preExecute(w, { agent: childAgent, name: "bash", parent: undefined, arguments: {} });
    check(
      "an explicit Full-access choice stops the inherited review",
      judged === 1 && afterFull.claimed === false,
      "judged=" + judged,
    );
    check(
      "the displayed preset follows the explicit choice",
      w.presets.current(child) === "danger-full-access",
      "displayed=" + w.presets.current(child),
    );

    // Re-publication (restart-like) must not resurrect it.
    const disposed = w.listeners.find((l) => l.event === "session/disposed");
    disposed.fn(child);
    agentCreated(w, childAgent);
    const afterRepublish = await preExecute(w, { agent: childAgent, name: "bash", parent: undefined, arguments: {} });
    check(
      "re-publication does not resurrect the inherited review",
      judged === 1 && afterRepublish.claimed === false,
      "judged=" + judged,
    );
    check(
      "re-publication appends no second marker",
      markerEvents(childLog).length === 1,
      "markers=" + markerEvents(childLog).length,
    );
    check(
      "the explicit choice stays the latest identity",
      lastPresetOf(childLog) === "danger-full-access",
      "last=" + lastPresetOf(childLog),
    );

    // The same for a child that explicitly picks another preset.
    const { child: child2, childAgent: childAgent2, childLog: childLog2 } = seedDelegatedChild(
      w,
      parent,
      "session-child-2",
    );
    agentCreated(w, childAgent2);
    const other = { type: "permission/preset", data: { preset: READ_ONLY } };
    childLog2.push(other);
    emit(w, child2, other.type, other.data);
    const afterOther = await preExecute(w, { agent: childAgent2, name: "bash", parent: undefined, arguments: {} });
    check(
      "an explicit read-only choice stops the inherited review",
      judged === 1 && afterOther.claimed === false,
      "judged=" + judged,
    );
    disposed.fn(child2);
    agentCreated(w, childAgent2);
    const afterOtherRepublish = await preExecute(w, { agent: childAgent2, name: "bash", parent: undefined, arguments: {} });
    check(
      "re-publication does not resurrect that opt-out either",
      judged === 1 && afterOtherRepublish.claimed === false,
      "judged=" + judged,
    );
    check(
      "that child kept exactly one marker",
      markerEvents(childLog2).length === 1,
      "markers=" + markerEvents(childLog2).length,
    );
  }

  section("父会话后进入 review 时已有子代理也获得标记");
  {
    const w = buildWorld();
    await AgentApprovalService.prototype[Service.init].call(w.inst);
    w.inst._jev = { apiKey: "k", endpoint: "e", model: "m", confidence: 0.5 };

    // The parent is NOT reviewed yet — the child is created first.
    const parentLog = [];
    seedUserKnobs(parentLog);
    const parent = makeSession("session-parent", parentLog, undefined, w);
    const parentAgent = { session: parent };
    w.ctx.__agents.set(parent.id, parentAgent);
    const { child, childAgent, childLog } = seedDelegatedChild(w, parent);
    agentCreated(w, childAgent);
    check(
      "no marker before the parent enters review",
      markerEvents(childLog).length === 0,
      "markers=" + markerEvents(childLog).length,
    );

    // Now the parent switches to 自动审查.
    parentLog.push({ type: "permission/preset", data: { preset: PRESET_REVIEW } });
    emit(w, parent, "permission/preset", { preset: PRESET_REVIEW });

    const markers = markerEvents(childLog);
    check(
      "the already-created child receives the marker",
      markers.length === 1,
      "markers=" + JSON.stringify(markers.map((m) => m.data)),
    );
    check(
      "the late marker carries the inherited-review source",
      markers.length === 1 && isInheritedSource(markers[0].data.source),
      "source=" + (markers.length === 1 ? markers[0].data.source : "(none)"),
    );
    check(
      "the late-covered child's knobs stay untouched",
      countEvents(childLog, "sandbox/mode") === 1 && countEvents(childLog, "approval/policy") === 1,
      "knobs=" +
        JSON.stringify(
          childLog.filter((e) => e.type === "sandbox/mode" || e.type === "approval/policy"),
        ),
    );

    let judged = 0;
    w.inst._reviewCall = async () => {
      judged += 1;
      return { kind: "deny", info: { name: "AgentReviewDeniedError" } };
    };
    const pe = await preExecute(w, { agent: childAgent, name: "bash", parent: undefined, arguments: {} });
    check("the late-covered child is judged", judged === 1 && pe.claimed === true, "judged=" + judged);
    check(
      "the late-covered child displays agent-review",
      w.presets.current(child) === PRESET_REVIEW,
      "displayed=" + w.presets.current(child),
    );
  }

  section("孙代理同样获得标记");
  {
    const w = buildWorld();
    await AgentApprovalService.prototype[Service.init].call(w.inst);
    w.inst._jev = { apiKey: "k", endpoint: "e", model: "m", confidence: 0.5 };

    const { parent } = seedReviewedParent(w);
    const { child, childAgent } = seedDelegatedChild(w, parent);
    agentCreated(w, childAgent);
    const { child: grand, childAgent: grandAgent, childLog: grandLog } = seedDelegatedChild(
      w,
      child,
      "session-grand",
      2,
    );
    agentCreated(w, grandAgent);

    const markers = markerEvents(grandLog);
    check(
      "the grandchild records its own marker",
      markers.length === 1,
      "markers=" + JSON.stringify(markers.map((m) => m.data)),
    );
    check(
      "the grandchild's marker carries the inherited-review source",
      markers.length === 1 && isInheritedSource(markers[0].data.source),
      "source=" + (markers.length === 1 ? markers[0].data.source : "(none)"),
    );
    check(
      "the grandchild's knobs stay untouched",
      countEvents(grandLog, "sandbox/mode") === 1 && countEvents(grandLog, "approval/policy") === 1,
      "knobs=" +
        JSON.stringify(
          grandLog.filter((e) => e.type === "sandbox/mode" || e.type === "approval/policy"),
        ),
    );

    let judged = 0;
    w.inst._reviewCall = async () => {
      judged += 1;
      return { kind: "deny", info: { name: "AgentReviewDeniedError" } };
    };
    const pe = await preExecute(w, { agent: grandAgent, name: "bash", parent: undefined, arguments: {} });
    check("the grandchild is judged through the chain", judged === 1 && pe.claimed === true, "judged=" + judged);
    check(
      "the grandchild displays agent-review",
      w.presets.current(grand) === PRESET_REVIEW,
      "displayed=" + w.presets.current(grand),
    );
  }

  // ---- post-denial re-approval (v1.11.0, Guardian-style overturn) ----------
  // A judge denial records the call fingerprint in _reviewDenied; an EXACT
  // retry must NOT short-circuit — it re-enters the judge carrying the denial
  // context (priorDenial), so an explicit, informed user re-approval visible
  // in the trusted user messages can overturn it. The recording side of the
  // bookkeeping lives inside the real backends (network-judged), so this
  // section drives the plumbing with a stubbed backend and asserts: no
  // context on first judgment, context on exact retry, entry cleared +
  // audit note on overturn, trust cache still preceding the judge.

  section("拒绝后翻案（post-denial re-approval）");
  {
    const w = buildWorld();
    await AgentApprovalService.prototype[Service.init].call(w.inst);
    const log = [];
    const session = makeSession("session-a", log);
    const agent = { session };
    w.ctx.__agents.set(session.id, agent);

    // Drive the REAL _reviewWithJev with a stubbed network layer (_jevRequest)
    // so the denial bookkeeping inside the backend is under test too.
    const seenStates = [];
    const jevBody = (choice) => ({
      model: "jev-test",
      answers: {
        decision: {
          choice: choice,
          confidence: 0.9,
          probabilities: { approve: choice === "approve" ? 0.9 : 0.1, reject: choice === "approve" ? 0.1 : 0.9 },
        },
        riskLevel: { choice: "medium", confidence: 0.8, probabilities: { low: 0.1, medium: 0.8, high: 0.1 } },
        concreteRisk: { noul: 0.05 },
      },
    });
    w.inst._jev = { apiKey: "k", endpoint: "e", model: "m", confidence: 0.5 };
    w.inst._jevRequest = async (cfg, state) => {
      seenStates.push(state.previouslyDenied === undefined ? null : state.previouslyDenied);
      return jevBody("approve");
    };

    const signal = new AbortController().signal; // the aborted race arm must wait, not settle
    const execA = { agent, name: "bash", parent: undefined, arguments: { command: "echo hi" }, signal };
    const execB = { agent, name: "bash", parent: undefined, arguments: { command: "echo bye" }, signal };
    const execC = { agent, name: "bash", parent: undefined, arguments: { command: "echo cat" }, signal };
    const keyB = 'bash\n{"command":"echo bye"}';
    const keyC = 'bash\n{"command":"echo cat"}';

    await w.inst._reviewCall(session, execA);
    check("first judgment carries no prior denial", seenStates[0] === null);

    w.inst._reviewDenied.set(session.id, new Map([[keyB, { at: "t0", backend: "jev", reason: "test denial" }]]));
    await w.inst._reviewCall(session, execB);
    check(
      "exact retry carries the denial context into the judge state",
      typeof seenStates[1] === "string" &&
        seenStates[1].indexOf("denied at t0") >= 0 &&
        seenStates[1].indexOf("test denial") >= 0,
      "state=" + seenStates[1],
    );
    check(
      "approval clears the denial entry",
      w.inst._reviewDenied.get(session.id).has(keyB) === false,
    );
    const last = w.records[w.records.length - 1];
    check(
      "overturn lands in the audit rationale",
      last !== undefined && (last.rationale || "").indexOf("[overturned prior denial]") >= 0,
      "rationale=" + (last === undefined ? "(none)" : last.rationale),
    );

    // A fresh judge REJECTION records the fingerprint for a later retry.
    w.inst._jevRequest = async (cfg, state) => {
      seenStates.push(state.previouslyDenied === undefined ? null : state.previouslyDenied);
      return jevBody("reject");
    };
    await w.inst._reviewCall(session, execC);
    const dm = w.inst._reviewDenied.get(session.id);
    check(
      "judge rejection records the denial entry",
      dm !== undefined && dm.has(keyC) && dm.get(keyC).backend === "jev",
    );
    check(
      "rejection itself is not an overturn",
      (w.records[w.records.length - 1].rationale || "").indexOf("[overturned prior denial]") < 0,
    );

    // Trust short-circuit still precedes the judge for approved calls.
    const seenLen = seenStates.length;
    await w.inst._reviewCall(session, execA);

    // PTC: an inner call inside a run_code program flows through the SAME
    // _reviewCall plumbing - the fingerprint is the INNER tool + args and
    // the maps are session-keyed, so the transport layer is invisible to
    // the denial/override path. The outer run_code transport itself stays
    // excluded (covered in the scope section above).
    w.inst._jevRequest = async (cfg, state) => {
      seenStates.push(state.previouslyDenied === undefined ? null : state.previouslyDenied);
      return jevBody("approve");
    };
    const ptcExec = { agent, name: "bash", parent: "run_code", arguments: { command: "echo ptc" }, signal };
    const keyP = 'bash\n{"command":"echo ptc"}';
    w.inst._reviewDenied.set(session.id, new Map([[keyP, { at: "t1", backend: "jev", reason: "ptc denial" }]]));
    await w.inst._reviewCall(session, ptcExec);
    const ptcState = seenStates[seenStates.length - 1];
    check(
      "PTC inner retry carries the denial context",
      typeof ptcState === "string" && ptcState.indexOf("ptc denial") >= 0,
      "state=" + ptcState,
    );
    check(
      "PTC overturn clears the denial entry",
      w.inst._reviewDenied.get(session.id).has(keyP) === false,
    );
    const ptcRecord = w.records[w.records.length - 1];
    check(
      "PTC overturn lands in the audit rationale",
      ptcRecord !== undefined && (ptcRecord.rationale || "").indexOf("[overturned prior denial]") >= 0,
      "rationale=" + (ptcRecord === undefined ? "(none)" : ptcRecord.rationale),
    );
  }

  console.log("\n" + (failures === 0 ? "all " + checks + " checks passed" : failures + " of " + checks + " checks FAILED"));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("harness error: " + (e && e.stack ? e.stack : String(e)));
  process.exit(1);
});
