/**
 * dsh-agent-approval — Host half.
 *
 * A Cordis "class plugin": this module exports an `AgentApprovalService`
 * extending `TypertRemoteService`. The DSH loader instantiates the class and
 * registers it as the `agentApproval` service; the Typert Gateway exposes its
 * `@Remote`-marked methods to the browser Client half under the
 * `agentApproval` Remote namespace.
 *
 * What it does (the "agent-approval" permission mode):
 *
 *   1. TOGGLE ON  — the session's sandbox base is pinned to workspace-write
 *      and its approval policy to `ask` (both prior knob values are remembered
 *      per session and restored on toggle-off). The knob writes go through
 *      the canonical paths (`approval.setPolicy`, `sandbox/mode` append), so
 *      the durable log stays the single source of truth.
 *
 *   2. JUDGE      — this service claims the `approval/request` waterfall with
 *      `{ prepend: true }`, so it runs BEFORE the interactive UI answerer:
 *      an enabled session never pops a human prompt. Every escalation ask is
 *      routed to a ONE-SHOT `spawn` subagent (own session, zero parent
 *      context, approval policy pinned to `never` by the delegation itself,
 *      every global tool blanked via `toolFilter: { allow: [] }`) that must
 *      answer through a structured-output schema:
 *          { decision: approve|reject, riskLevel, rationale }
 *      The judge sees the exact tool arguments (read from the session log by
 *      `callId`) plus the asker's stated reason, and is instructed to fail
 *      closed: destructive / irreversible / out-of-scope / dishonest requests
 *      are rejected.
 *
 *   3. FAIL CLOSED — any infrastructure fault, timeout, malformed verdict, or
 *      cancellation maps to the fail-closed approval outcomes
 *      (`unavailable` / `cancelled`), never to a grant.
 *
 *   4. AUDIT      — every decision is recorded (in-memory, capped) and shown
 *      in the Settings page; the judge's own child session id is kept so the
 *      full reasoning trail can be inspected in the session list.
 *
 * Mount on the HOST plane (profile `cordis.patch.yml` insert row): the
 * approval waterfall listener must be unscoped to see every live agent, and
 * the `subagents` registry / `spawn` provider live in the host composition.
 */

import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { Service } from "@deepseek-ai/cordis";

// ---- constants --------------------------------------------------------------

/** The sandbox mode an enabled session is pinned to while the mode is ON. */
const BASE_MODE = "workspace-write";
/** Default / clamp bounds for the judge timeout (milliseconds, fail-closed). */
const DEFAULT_TIMEOUT_MS = 120000;
const MIN_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 600000;
/** In-memory audit ring size (the Settings page shows the latest 50). */
const MAX_RECORDS = 200;

/**
 * The structured verdict the judge subagent MUST produce. Constrained to the
 * JSON-Schema subset `assertObjectJsonSchema` enforces for subagent outputs
 * (type/properties/required/additionalProperties/enum only).
 */
const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    decision: {
      type: "string",
      enum: ["approve", "reject"],
      description: "The verdict for this escalation request.",
    },
    riskLevel: {
      type: "string",
      enum: ["low", "medium", "high"],
      description: "How risky the requested operation is.",
    },
    rationale: {
      type: "string",
      description: "Two or three sentences justifying the verdict.",
    },
  },
  required: ["decision", "riskLevel", "rationale"],
  additionalProperties: false,
};

/** Shadowing persona for the judge child (spawn provider capability). */
const APPROVER_PERSONA = [
  "You are an independent security approval agent inside a coding harness.",
  "Your only job is to judge ONE request for wider sandbox access and report the verdict through the structured_output tool.",
  "You are conservative and fail closed: when uncertain, when the operation is destructive or irreversible, when it reaches outside its stated purpose, or when the stated justification does not match the actual arguments, you REJECT.",
  "You never ask questions, never attempt the operation yourself, and never finish with a plain-text answer.",
].join(" ");

// ---- helpers ----------------------------------------------------------------

/**
 * Mark one instance method as a Remote export without relying on decorator
 * syntax (Node ESM does not support the proposal decorators here). We drive
 * the same `Remote(name)` decorator manually through a synthetic decorator
 * context and run the registered initializers against the instance.
 *
 * @param {object} instance - live service instance whose prototype is marked.
 * @param {string} method - public instance method name.
 * @param {string} [exportName] - wire export name; defaults to the method name.
 */
function markRemoteMethod(instance, method, exportName) {
  const decorator = Remote(method, undefined);
  const initializers = [];
  decorator(undefined, {
    kind: "method",
    name: method,
    static: false,
    private: false,
    addInitializer: (fn) => initializers.push(fn),
  });
  for (const fn of initializers) fn.call(instance);
}

/** Truncate a long string for the audit record; pass through non-strings as "". */
function trunc(value, n) {
  if (typeof value !== "string") return "";
  return value.length > n ? value.slice(0, n) + "…[truncated]" : value;
}

/** First 8 chars of a session id (display form in records and chips). */
function shortId(id) {
  return String(id).slice(0, 8);
}

/** Best-effort error text. */
function errText(e) {
  return e && typeof e.message === "string" ? e.message : String(e);
}

// ---- service ----------------------------------------------------------------

export class AgentApprovalService extends TypertRemoteService {
  /**
   * Hard dependencies (the plugin parks until all exist — correct: without
   * them approvals must not silently degrade):
   *   - approval    : the waterfall we claim + the policy setter
   *   - subagents   : the `spawn` provider backing the judge child
   *   - agents      : sessionId → live Agent lookup for the client toggle
   *   - timer       : `ctx.timeout` for the judge race (fail-closed timeout)
   * Optional surfaces (`llm`, `agentDefaultModel`, `systemPrompt`, `commands`)
   * are read opportunistically / mounted via `ctx.inject([...])` below.
   */
  static inject = ["approval", "subagents", "agents", "timer"];

  /**
   * Cordis instantiates class plugins with `new Callback(ctx, config)` — the
   * second argument is the plugin config, NOT the service key. Pass the exact
   * service key to `super()`.
   */
  constructor(ctx, config) {
    super(ctx, "agentApproval");
  }

  /**
   * Cordis class-plugin initializer: runs right after construction, before the
   * service is published. Mark the Remote methods, then arm the claimer.
   */
  [Service.init]() {
    markRemoteMethod(this, "getState", "getState");
    markRemoteMethod(this, "setModel", "setModel");
    markRemoteMethod(this, "setApprovalTimeout", "setApprovalTimeout");
    markRemoteMethod(this, "toggle", "toggle");
    markRemoteMethod(this, "clearRecords", "clearRecords");
    markRemoteMethod(this, "directory", "directory");

    /** Judge model route; empty strings = inherit the requesting session's. */
    this._model = { provider: "", model: "" };
    /** Judge timeout in ms (clamped); a timeout resolves fail-closed. */
    this._timeoutMs = DEFAULT_TIMEOUT_MS;
    /** sessionId -> { prevSandbox?: string, prevApproval?: string } */
    this._enabled = new Map();
    /** Audit records, oldest first, capped at MAX_RECORDS. */
    this._records = [];

    // Claim escalations BEFORE the interactive answerer. The host apiproxy
    // answerer registered earlier (composition load order); `{ prepend: true }`
    // puts this listener at the head of the hook list, i.e. OUTERMOST in the
    // waterfall, so an enabled session's ask never reaches the human prompt.
    // Everything we do not claim falls through to the rest of the chain
    // untouched.
    this.ctx.on("approval/request", (req, next) => this._onApprovalRequest(req, next), { prepend: true });

    // Optional capability surfaces — each child activates only when its
    // registry is composed, and unwinds with it.
    this.ctx.inject(["systemPrompt"], (scope) => {
      scope.systemPrompt.context({
        name: "agent-approval:policy",
        order: 116,
        text: (context) => {
          const agent = context.agent;
          if (agent === undefined || !this._enabled.has(agent.session.id)) return "";
          const route =
            this._model.provider !== ""
              ? ` routed to ${this._model.provider}/${this._model.model}`
              : "";
          return (
            "Agent-approval mode is ON for this session: the sandbox base is workspace-write, and every sandbox-escalation request is decided by an independent approval agent" +
            route +
            ". The approver sees the exact command or file operation plus your justification, approves only plausibly safe, reversible operations consistent with the task, and rejects risky, destructive, or poorly justified ones. A rejection is final for that exact operation — do not retry it."
          );
        },
      });
    });

    this.ctx.inject(["commands"], (scope) => {
      scope.commands.register({
        name: "agent-approval",
        description:
          "Toggle agent-decided approvals: workspace-write base + an independent approval agent judges every sandbox escalation",
        input: { hint: "<on|off>" },
        handler: (invocation) => {
          const arg = invocation.rawInput.trim().toLowerCase();
          if (arg === "") {
            const on = this._enabled.has(invocation.agent.session.id);
            return {
              kind: "success",
              text: "agent-approval is " + (on ? "ON" : "OFF") + " for this session (usage: /agent-approval on|off)",
            };
          }
          if (arg !== "on" && arg !== "off") {
            return { kind: "error", text: "usage: /agent-approval on|off" };
          }
          return { kind: "success", text: this._setEnabled(invocation.agent, arg === "on") };
        },
      });
    });
  }

  // ---- knob plumbing --------------------------------------------------------

  /** Last `sandbox/mode` / `approval/policy` value in the session log fold. */
  _lastKnob(session, type, field) {
    const events = session.events;
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.type === type) return e.data[field];
    }
    return undefined;
  }

  /**
   * Toggle the mode for one live agent's session.
   *
   * ON:  remember the session's EFFECTIVE knob values (override ?? defaults —
   *      a session living under a `never` composition default must return to
   *      `never`, not to the fold's "no override" state), then pin sandbox to
   *      workspace-write and approval policy to `ask` (the waterfall — and
   *      therefore our claimer — only runs under `ask`; under `never` the
   *      approval service short-circuits to `rejected` before any listener).
   * OFF: restore the remembered values through the canonical setters (both
   *      no-op when unchanged).
   */
  _setEnabled(agent, on) {
    const session = agent.session;
    if (on) {
      if (this._enabled.has(session.id)) return "agent-approval is already ON for this session";
      const approval = this.ctx.approval;
      const effectiveSandbox =
        this._lastKnob(session, "sandbox/mode", "mode") ??
        this.ctx.get("sandboxPolicy")?.defaultMode ??
        BASE_MODE;
      const effectiveApproval =
        approval.overrideOf(session) ?? approval.config?.policy ?? "ask";
      this._enabled.set(session.id, { prevSandbox: effectiveSandbox, prevApproval: effectiveApproval });
      if (effectiveSandbox !== BASE_MODE) session.append("sandbox/mode", { mode: BASE_MODE });
      approval.setPolicy(agent, "ask");
      return "agent-approval ON: sandbox base is workspace-write; escalations are judged by the independent approval agent";
    }
    const prev = this._enabled.get(session.id);
    if (prev === undefined) return "agent-approval is not ON for this session";
    this._enabled.delete(session.id);
    if (
      typeof prev.prevSandbox === "string" &&
      prev.prevSandbox !== this._lastKnob(session, "sandbox/mode", "mode")
    ) {
      session.append("sandbox/mode", { mode: prev.prevSandbox });
    }
    if (typeof prev.prevApproval === "string") {
      this.ctx.approval.setPolicy(agent, prev.prevApproval);
    }
    return "agent-approval OFF: previous permission knobs restored";
  }

  // ---- audit ----------------------------------------------------------------

  /** Append one audit record (all fields coerced to wire shape) and cap. */
  _record(entry) {
    this._records.push({
      at: String(entry.at),
      sessionId: String(entry.sessionId),
      toolName: String(entry.toolName),
      reason: String(entry.reason),
      args: String(entry.args),
      outcome: entry.outcome,
      riskLevel: String(entry.riskLevel),
      model: String(entry.model),
      durationMs: Number(entry.durationMs) || 0,
      childSessionId: String(entry.childSessionId),
      rationale: String(entry.rationale),
    });
    if (this._records.length > MAX_RECORDS) {
      this._records.splice(0, this._records.length - MAX_RECORDS);
    }
  }

  // ---- the claimer ----------------------------------------------------------

  /** Read the exact tool-call arguments JSON from the session log by callId. */
  _callArgsOf(session, callId) {
    if (callId === undefined) return undefined;
    const events = session.events;
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.type === "tool/call" && e.data.callId === callId) return e.data.arguments;
    }
    return undefined;
  }

  _judgePrompt(session, req, argsRaw) {
    let cwd = "";
    try {
      if (session.header && typeof session.header.cwd === "string") cwd = session.header.cwd;
    } catch (e) {
      /* header access is best-effort */
    }
    return [
      "Judge this one-time approval/escalation request from a coding agent.",
      "",
      "Workspace (cwd): " + (cwd !== "" ? cwd : "(unknown)"),
      "Tool requesting approval: " + String(req.toolName),
      "Stated reason: " + (typeof req.reason === "string" && req.reason !== "" ? req.reason : "(none)"),
      "Exact tool arguments (raw JSON, possibly truncated):",
      argsRaw === undefined ? "(not available)" : trunc(argsRaw, 4000) || "(empty)",
      "",
      "APPROVE only if ALL of the following hold:",
      "- the operation is plausibly safe, non-destructive, and reversible;",
      "- it stays within, or is clearly required by, the agent's stated task;",
      "- the stated reason honestly matches the actual arguments;",
      "- granting it once cannot leak secrets or cause irreversible system changes.",
      "REJECT when the operation is destructive (mass deletion, disk formatting, registry/service/system-wide changes), exfiltrates credentials or secrets, touches resources unrelated to the task, hides intent behind encoded or obfuscated content, or the reason does not match the arguments.",
      "When uncertain, REJECT. Report the verdict via the structured_output tool only.",
    ].join("\n");
  }

  /**
   * The approval/request waterfall listener (outermost — see Service.init).
   * Claims every ask for an enabled session; delegates everything else via
   * `next()` OUTSIDE any try/catch, so a failure deeper in the chain keeps its
   * own semantics (the approval service normalizes it) instead of being
   * recorded as our fault. Our own judging never throws: any internal fault
   * resolves fail-closed.
   */
  async _onApprovalRequest(req, next) {
    const agent = req.agent;
    const session = agent.session;
    if (!this._enabled.has(session.id)) return next();
    // Without a signal we cannot race cancellation; leave it to the chain.
    if (req.signal === undefined) return next();

    try {
      return await this._judge(session, agent, req);
    } catch (e) {
      // A listener throw would make the whole waterfall fail closed with
      // 'unavailable' anyway; record what we can and resolve the same way.
      try {
        this._record({
          at: new Date().toISOString(),
          sessionId: shortId(session.id),
          toolName: String(req.toolName),
          reason: trunc(req.reason, 300),
          args: "",
          outcome: "unavailable",
          riskLevel: "-",
          model: this._modelLabel(),
          durationMs: 0,
          childSessionId: "",
          rationale: "claimer fault (fail closed): " + errText(e),
        });
      } catch (e2) {
        /* recording must never mask the fail-closed return */
      }
      return "unavailable";
    }
  }

  /** Build the "inherit/configured" label used in audit records. */
  _modelLabel() {
    return this._model.provider !== ""
      ? this._model.provider + "/" + this._model.model
      : "inherit(requester)";
  }

  /** Spawn the judge subagent, race it against abort/timeout, map the verdict. */
  async _judge(session, agent, req) {
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    const argsRaw = this._callArgsOf(session, req.callId);
    const base = {
      at: startedAt,
      sessionId: shortId(session.id),
      toolName: String(req.toolName),
      reason: trunc(req.reason, 300),
      args: trunc(argsRaw, 2000),
      model: this._modelLabel(),
      durationMs: 0,
      childSessionId: "",
    };

    let run;
    try {
      run = await this.ctx.subagents.start("spawn", {
        label: "approval-judge",
        prompt: [{ type: "text", text: this._judgePrompt(session, req, argsRaw) }],
        parent: agent,
        signal: req.signal,
        ...(this._model.provider !== "" && this._model.model !== ""
          ? { agentOptions: { provider: this._model.provider, model: this._model.model } }
          : {}),
        outputSchema: VERDICT_SCHEMA,
        toolFilter: { allow: [] },
        persona: APPROVER_PERSONA,
      });
    } catch (error) {
      this._record({ ...base, outcome: "unavailable", riskLevel: "-", rationale: "approval agent failed to start: " + errText(error) });
      return "unavailable";
    }
    base.childSessionId = shortId(run.id);

    let winner;
    try {
      const abortRace = new Promise((resolve) => {
        const sig = req.signal;
        if (sig.aborted) {
          resolve("aborted");
          return;
        }
        sig.addEventListener("abort", () => resolve("aborted"), { once: true });
      });
      winner = await Promise.race([
        run.result.then(
          (r) => ({ kind: "result", result: r }),
          (error) => ({ kind: "fault", error }),
        ),
        abortRace.then((v) => ({ kind: v })),
        this.ctx.timeout(this._timeoutMs).then(() => ({ kind: "timeout" })),
      ]);
    } finally {
      run.dispose().catch(() => {});
    }
    base.durationMs = Date.now() - t0;

    if (winner.kind === "result") {
      const result = winner.result;
      const verdict = result.structured;
      if (
        result.stopReason === "completed" &&
        verdict !== undefined &&
        (verdict.decision === "approve" || verdict.decision === "reject")
      ) {
        const approved = verdict.decision === "approve";
        this._record({
          ...base,
          outcome: approved ? "allowed-once" : "rejected",
          riskLevel: String(verdict.riskLevel || "-"),
          rationale: trunc(verdict.rationale, 600),
        });
        return approved ? "allowed-once" : "rejected";
      }
      this._record({
        ...base,
        outcome: "unavailable",
        riskLevel: "-",
        rationale:
          "approval agent returned no valid verdict (stopReason: " + String(result.stopReason) + ")",
      });
      return "unavailable";
    }
    if (winner.kind === "aborted") {
      this._record({ ...base, outcome: "cancelled", riskLevel: "-", rationale: "request cancelled while the approval agent was judging" });
      return "cancelled";
    }
    if (winner.kind === "timeout") {
      this._record({
        ...base,
        outcome: "unavailable",
        riskLevel: "-",
        rationale: "approval agent timed out after " + String(this._timeoutMs) + "ms (fail closed)",
      });
      return "unavailable";
    }
    this._record({ ...base, outcome: "unavailable", riskLevel: "-", rationale: "approval agent infrastructure fault: " + errText(winner.error) });
    return "unavailable";
  }

  // ---- Remote API ------------------------------------------------------------

  /** Snapshot for the Settings page and the composer toggle. */
  async getState() {
    return {
      ok: true,
      value: {
        model: { provider: this._model.provider, model: this._model.model },
        timeoutMs: this._timeoutMs,
        enabledSessions: Array.from(this._enabled.keys()).map(String),
        records: this._records.slice(-50).reverse(),
      },
    };
  }

  /**
   * Set the judge model route. Empty strings clear the override (inherit the
   * requesting session's provider/model).
   */
  async setModel(request) {
    const provider = request && typeof request.provider === "string" ? request.provider : "";
    const model = request && typeof request.model === "string" ? request.model : "";
    this._model =
      provider !== "" && model !== "" ? { provider, model } : { provider: "", model: "" };
    return { ok: true, value: { model: { provider: this._model.provider, model: this._model.model } } };
  }

  /** Set the judge timeout (clamped to [MIN, MAX] milliseconds). */
  async setApprovalTimeout(request) {
    const raw = request && typeof request.timeoutMs === "number" ? request.timeoutMs : 0;
    this._timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(raw)));
    return { ok: true, value: { timeoutMs: this._timeoutMs } };
  }

  /** Toggle the mode for one live session (called by the composer chip). */
  async toggle(request) {
    const sessionId =
      request && typeof request.sessionId === "string" ? request.sessionId : "";
    const want = !!(request && request.on);
    if (sessionId === "") {
      return { ok: false, error: { code: "invalid-session", message: "sessionId is required" } };
    }
    const agent = this.ctx.agents.get(sessionId);
    if (agent === undefined) {
      return {
        ok: false,
        error: { code: "session-not-live", message: "that session is not live right now" },
      };
    }
    return { ok: true, value: { message: this._setEnabled(agent, want) } };
  }

  /** Clear the in-memory audit records. */
  async clearRecords() {
    this._records = [];
    return { ok: true, value: { cleared: true } };
  }

  /**
   * Directory for the Settings pickers: registered providers, their models,
   * and the harness default selection (for the "inherit" hint).
   */
  async directory() {
    const out = { providers: [], models: [], defaultSelection: null };
    const llm = this.ctx.get("llm");
    if (llm !== undefined) {
      try {
        const providers = llm.listProviders();
        out.providers = providers.map((p) => ({ id: String(p.id), name: String(p.name) }));
        for (const p of providers) {
          try {
            const models = await llm.listModels(p.id);
            for (const m of models) {
              out.models.push({ provider: String(p.id), id: String(m.id), name: String(m.name || m.id) });
            }
          } catch (e) {
            /* a provider without a listing stays empty */
          }
        }
      } catch (e) {
        /* directory degraded to empty */
      }
    }
    const adm = this.ctx.get("agentDefaultModel");
    if (adm !== undefined) {
      try {
        const sel = adm.currentSelection();
        out.defaultSelection = { provider: String(sel.provider), model: String(sel.model) };
      } catch (e) {
        /* optional convenience */
      }
    }
    return { ok: true, value: out };
  }
}

export default AgentApprovalService;
