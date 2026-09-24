/**
 * dsh-agent-approval — Typert Host manifest.
 *
 * Hand-written TYPERT manifest (the format the DSH typert-loader consumes from
 * the package's `./typert` export). It describes the `agentApproval` Remote
 * service the Host half publishes so the browser Client half can call it
 * through `ctx.remote.agentApproval.*` (after mounting the namespace via
 * `ctx.remote.$mount` — see client.js).
 *
 * Keep the invocation ids, service/namespace names and method names in sync
 * with `index.js` (AgentApprovalService) and `client.js`.
 *
 * Result schemas are STRICT: every Host return value must match exactly
 * (fields present, types correct), or the gateway validation fails.
 *
 * Codec wire format spans two host generations (v1.7.0): DSH ≤ 0.1.5-rc.3
 * validates and parses through `codec.schema` (a zod v4 instance — the
 * typert-loader checked `"_zod" in schema`, the gateway called
 * `codec.schema.parse`), while DSH 0.1.7-rc.1+ replaced that contract with a
 * `codec.create()` FACTORY (the loader now rejects any codec "with no create()
 * factory"; the gateway calls `codec.create().parse`). Every codec below
 * therefore carries BOTH fields: `schema` keeps 0.1.5 loading, `create` keeps
 * 0.1.7 loading, and both generations parse through the same zod instance.
 * Removing either field breaks one generation at startup (the typert-loader
 * throw is why 0.1.7 refused this manifest before v1.7.0).
 */

import { z } from "zod";

// ---- shared shapes ---------------------------------------------------------

const recordSchema = z
  .object({
    at: z.string(),
    sessionId: z.string(),
    toolName: z.string(),
    reason: z.string(),
    args: z.string(),
    outcome: z.enum(["allowed-once", "rejected", "cancelled", "unavailable"]),
    riskLevel: z.string(),
    model: z.string(),
    durationMs: z.number(),
    childSessionId: z.string(),
    rationale: z.string(),
  })
  .readonly();

const modelRouteSchema = z
  .object({
    provider: z.string(),
    model: z.string(),
  })
  .readonly();

const jevConfigSchema = z
  .object({
    apiKey: z.string(),
    endpoint: z.string(),
    model: z.string(),
    confidence: z.number(),
  })
  .readonly();

const enabledSessionSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    cwd: z.string(),
  })
  .readonly();

const ruleSchema = z
  .object({
    id: z.string(),
    effect: z.enum(["allow", "deny"]),
    tool: z.string(),
    match: z.string(),
    note: z.string(),
    createdAt: z.string(),
  })
  .readonly();

const stateValueSchema = z
  .object({
    model: modelRouteSchema,
    jev: jevConfigSchema,
    timeoutMs: z.number(),
    enabledSessions: z.array(enabledSessionSchema).readonly(),
    rules: z.array(ruleSchema).readonly(),
  })
  .readonly();

const setModelValueSchema = z
  .object({
    model: modelRouteSchema,
  })
  .readonly();

const setJevValueSchema = z
  .object({
    jev: jevConfigSchema,
  })
  .readonly();

const setTimeoutValueSchema = z
  .object({
    timeoutMs: z.number(),
  })
  .readonly();

const toggleValueSchema = z
  .object({
    message: z.string(),
  })
  .readonly();

const rulesValueSchema = z
  .object({
    rules: z.array(ruleSchema).readonly(),
  })
  .readonly();

const sessionRecordsValueSchema = z
  .object({
    records: z.array(recordSchema).readonly(),
    enabled: z.boolean(),
  })
  .readonly();

const directoryValueSchema = z
  .object({
    providers: z
      .array(
        z
          .object({
            id: z.string(),
            name: z.string(),
          })
          .readonly(),
      )
      .readonly(),
    models: z
      .array(
        z
          .object({
            provider: z.string(),
            id: z.string(),
            name: z.string(),
          })
          .readonly(),
      )
      .readonly(),
    defaultSelection: z.union([modelRouteSchema, z.null()]),
  })
  .readonly();

/** The shared ok|error envelope. */
function okResult(valueSchema) {
  return z.union([
    z
      .object({
        ok: z.literal(true).readonly(),
        value: valueSchema.readonly(),
      })
      .readonly(),
    z
      .object({
        ok: z.literal(false).readonly(),
        error: z
          .object({
            code: z.string().readonly(),
            message: z.string().readonly().optional(),
          })
          .readonly(),
      })
      .readonly(),
  ]);
}

const stateResultSchema = okResult(stateValueSchema);
const setModelResultSchema = okResult(setModelValueSchema);
const setJevResultSchema = okResult(setJevValueSchema);
const setTimeoutResultSchema = okResult(setTimeoutValueSchema);
const toggleResultSchema = okResult(toggleValueSchema);
const addRuleResultSchema = okResult(rulesValueSchema);
const removeRuleResultSchema = okResult(rulesValueSchema);
const sessionRecordsResultSchema = okResult(sessionRecordsValueSchema);
const directoryResultSchema = okResult(directoryValueSchema);

// ---- per-invocation parameter schemas ----------------------------------------

const _agentApproval_setModel_parameter_0$schema = z.object({
  provider: z.string(),
  model: z.string(),
});

const _agentApproval_setJevConfig_parameter_0$schema = z.object({
  apiKey: z.string(),
  endpoint: z.string(),
  model: z.string(),
  confidence: z.number(),
});

const _agentApproval_setApprovalTimeout_parameter_0$schema = z.object({
  timeoutMs: z.number(),
});

const _agentApproval_toggle_parameter_0$schema = z.object({
  sessionId: z.string(),
  on: z.boolean(),
});

const _agentApproval_addRule_parameter_0$schema = z.object({
  effect: z.enum(["allow", "deny"]),
  tool: z.string(),
  match: z.string(),
  note: z.string(),
});

const _agentApproval_removeRule_parameter_0$schema = z.object({
  id: z.string(),
});

const _agentApproval_sessionRecords_parameter_0$schema = z.object({
  sessionId: z.string(),
});

export const TYPERT = {
  package: "@duke-dsh-plugins/dsh-agent-approval",
  face: "host",
  schemas: [],
  invocations: [
    {
      id: "dsh-agent-approval#agentApproval/getState",
      service: "agentApproval",
      namespace: "agentApproval",
      method: "getState",
      invocation: { kind: "direct" },
      parameters: [],
      result: {
        mode: "strict",
        typeSymbol: "dsh-agent-approval#AgentApprovalStateResult",
        schema: stateResultSchema,
        create: () => stateResultSchema,
      },
      sourceLocation: { file: "index.js", line: 1, column: 1 },
    },
    {
      id: "dsh-agent-approval#agentApproval/setModel",
      service: "agentApproval",
      namespace: "agentApproval",
      method: "setModel",
      invocation: { kind: "direct" },
      parameters: [
        {
          name: "request",
          wire: "request",
          source: "json",
          codec: {
            mode: "strict",
            typeSymbol: "dsh-agent-approval#AgentApprovalSetModelRequest",
            schema: _agentApproval_setModel_parameter_0$schema,
            create: () => _agentApproval_setModel_parameter_0$schema,
          },
        },
      ],
      result: {
        mode: "strict",
        typeSymbol: "dsh-agent-approval#AgentApprovalSetModelResult",
        schema: setModelResultSchema,
        create: () => setModelResultSchema,
      },
      sourceLocation: { file: "index.js", line: 1, column: 1 },
    },
    {
      id: "dsh-agent-approval#agentApproval/setJevConfig",
      service: "agentApproval",
      namespace: "agentApproval",
      method: "setJevConfig",
      invocation: { kind: "direct" },
      parameters: [
        {
          name: "request",
          wire: "request",
          source: "json",
          codec: {
            mode: "strict",
            typeSymbol: "dsh-agent-approval#AgentApprovalSetJevRequest",
            schema: _agentApproval_setJevConfig_parameter_0$schema,
            create: () => _agentApproval_setJevConfig_parameter_0$schema,
          },
        },
      ],
      result: {
        mode: "strict",
        typeSymbol: "dsh-agent-approval#AgentApprovalSetJevResult",
        schema: setJevResultSchema,
        create: () => setJevResultSchema,
      },
      sourceLocation: { file: "index.js", line: 1, column: 1 },
    },
    {
      id: "dsh-agent-approval#agentApproval/setApprovalTimeout",
      service: "agentApproval",
      namespace: "agentApproval",
      method: "setApprovalTimeout",
      invocation: { kind: "direct" },
      parameters: [
        {
          name: "request",
          wire: "request",
          source: "json",
          codec: {
            mode: "strict",
            typeSymbol: "dsh-agent-approval#AgentApprovalSetTimeoutRequest",
            schema: _agentApproval_setApprovalTimeout_parameter_0$schema,
            create: () => _agentApproval_setApprovalTimeout_parameter_0$schema,
          },
        },
      ],
      result: {
        mode: "strict",
        typeSymbol: "dsh-agent-approval#AgentApprovalSetTimeoutResult",
        schema: setTimeoutResultSchema,
        create: () => setTimeoutResultSchema,
      },
      sourceLocation: { file: "index.js", line: 1, column: 1 },
    },
    {
      id: "dsh-agent-approval#agentApproval/toggle",
      service: "agentApproval",
      namespace: "agentApproval",
      method: "toggle",
      invocation: { kind: "direct" },
      parameters: [
        {
          name: "request",
          wire: "request",
          source: "json",
          codec: {
            mode: "strict",
            typeSymbol: "dsh-agent-approval#AgentApprovalToggleRequest",
            schema: _agentApproval_toggle_parameter_0$schema,
            create: () => _agentApproval_toggle_parameter_0$schema,
          },
        },
      ],
      result: {
        mode: "strict",
        typeSymbol: "dsh-agent-approval#AgentApprovalToggleResult",
        schema: toggleResultSchema,
        create: () => toggleResultSchema,
      },
      sourceLocation: { file: "index.js", line: 1, column: 1 },
    },
    {
      id: "dsh-agent-approval#agentApproval/addRule",
      service: "agentApproval",
      namespace: "agentApproval",
      method: "addRule",
      invocation: { kind: "direct" },
      parameters: [
        {
          name: "request",
          wire: "request",
          source: "json",
          codec: {
            mode: "strict",
            typeSymbol: "dsh-agent-approval#AgentApprovalAddRuleRequest",
            schema: _agentApproval_addRule_parameter_0$schema,
            create: () => _agentApproval_addRule_parameter_0$schema,
          },
        },
      ],
      result: {
        mode: "strict",
        typeSymbol: "dsh-agent-approval#AgentApprovalRulesResult",
        schema: addRuleResultSchema,
        create: () => addRuleResultSchema,
      },
      sourceLocation: { file: "index.js", line: 1, column: 1 },
    },
    {
      id: "dsh-agent-approval#agentApproval/removeRule",
      service: "agentApproval",
      namespace: "agentApproval",
      method: "removeRule",
      invocation: { kind: "direct" },
      parameters: [
        {
          name: "request",
          wire: "request",
          source: "json",
          codec: {
            mode: "strict",
            typeSymbol: "dsh-agent-approval#AgentApprovalRemoveRuleRequest",
            schema: _agentApproval_removeRule_parameter_0$schema,
            create: () => _agentApproval_removeRule_parameter_0$schema,
          },
        },
      ],
      result: {
        mode: "strict",
        typeSymbol: "dsh-agent-approval#AgentApprovalRulesResult",
        schema: removeRuleResultSchema,
        create: () => removeRuleResultSchema,
      },
      sourceLocation: { file: "index.js", line: 1, column: 1 },
    },
    {
      id: "dsh-agent-approval#agentApproval/sessionRecords",
      service: "agentApproval",
      namespace: "agentApproval",
      method: "sessionRecords",
      invocation: { kind: "direct" },
      parameters: [
        {
          name: "request",
          wire: "request",
          source: "json",
          codec: {
            mode: "strict",
            typeSymbol: "dsh-agent-approval#AgentApprovalSessionRecordsRequest",
            schema: _agentApproval_sessionRecords_parameter_0$schema,
            create: () => _agentApproval_sessionRecords_parameter_0$schema,
          },
        },
      ],
      result: {
        mode: "strict",
        typeSymbol: "dsh-agent-approval#AgentApprovalSessionRecordsResult",
        schema: sessionRecordsResultSchema,
        create: () => sessionRecordsResultSchema,
      },
      sourceLocation: { file: "index.js", line: 1, column: 1 },
    },
    {
      id: "dsh-agent-approval#agentApproval/directory",
      service: "agentApproval",
      namespace: "agentApproval",
      method: "directory",
      invocation: { kind: "direct" },
      parameters: [],
      result: {
        mode: "strict",
        typeSymbol: "dsh-agent-approval#AgentApprovalDirectoryResult",
        schema: directoryResultSchema,
        create: () => directoryResultSchema,
      },
      sourceLocation: { file: "index.js", line: 1, column: 1 },
    },
  ],
  model: {
    services: [
      {
        description:
          "Agent-approval permission mode service: pins enabled sessions to a workspace-write base, judges every sandbox escalation with an independent approval subagent (fail closed), appends the audit trail to each session's own log, and exposes model config to the DeepSeek Harness web UI.",
        summary: "Agent-approval permission mode service.",
        tags: [],
        jsDoc:
          "/**\n * Agent-approval permission mode service: workspace-write base + independent approval agent.\n */",
        key: "agentApproval",
        exportName: "AgentApprovalService",
        members: [
          {
            kind: "method",
            name: "getState",
            signature: "@Remote('getState') async getState(): Promise<AgentApprovalStateResult>",
            summary: "Snapshot for the Settings page (model route, Jev backend, timeout, enabled sessions, rules).",
            jsDoc:
              "/**\n * Return the judge model route, the TypeSafe Jev backend settings, timeout, enabled sessions (id + session-list title + workspace cwd), and the rule table.\n * @returns success or a business failure.\n */",
          },
          {
            kind: "method",
            name: "setModel",
            signature: "@Remote('setModel') async setModel(request: AgentApprovalSetModelRequest): Promise<AgentApprovalSetModelResult>",
            summary: "Set the judge model route (empty strings = inherit the requesting session's; provider 'typesafe' selects the Jev backend).",
            jsDoc:
              "/**\n * Set provider/model used by the approval judge; empty strings clear the override. The synthetic provider 'typesafe' routes judging through the TypeSafe Jev HTTP API instead of a harness subagent.\n * @param request - { provider, model }.\n * @returns the stored route.\n */",
          },
          {
            kind: "method",
            name: "setJevConfig",
            signature: "@Remote('setJevConfig') async setJevConfig(request: AgentApprovalSetJevRequest): Promise<AgentApprovalSetJevResult>",
            summary: "Set the TypeSafe Jev backend settings (API key, endpoint, model, confidence gate; persisted).",
            jsDoc:
              "/**\n * Update the Jev backend settings used when the judge provider is 'typesafe'. Only provided fields change; confidence (the fail-closed gate) is clamped to [0.01, 0.99].\n * @param request - { apiKey, endpoint, model, confidence }.\n * @returns the stored Jev settings.\n */",
          },
          {
            kind: "method",
            name: "setApprovalTimeout",
            signature: "@Remote('setApprovalTimeout') async setApprovalTimeout(request: AgentApprovalSetTimeoutRequest): Promise<AgentApprovalSetTimeoutResult>",
            summary: "Set the judge timeout in ms (clamped 30000–600000; timeout resolves fail-closed).",
            jsDoc:
              "/**\n * Set the approval-agent timeout, clamped to [30000, 600000] milliseconds.\n * @param request - { timeoutMs }.\n * @returns the stored timeout.\n */",
          },
          {
            kind: "method",
            name: "toggle",
            signature: "@Remote('toggle') async toggle(request: AgentApprovalToggleRequest): Promise<AgentApprovalToggleResult>",
            summary: "Toggle the mode for one live session (pin/restore the permission knobs).",
            jsDoc:
              "/**\n * Enable (workspace-write base + judged escalations) or disable (restore prior knobs) for one live session.\n * @param request - { sessionId, on }.\n * @returns a human-readable message, or session-not-live.\n */",
          },
          {
            kind: "method",
            name: "addRule",
            signature: "@Remote('addRule') async addRule(request: AgentApprovalAddRuleRequest): Promise<AgentApprovalRulesResult>",
            summary: "Add a deterministic allow/deny rule judged before the model (persisted).",
            jsDoc:
              "/**\n * Add one rule: tool = exact name or \"*\"; match = \"\" (every call), substring, or /regex/flags over the raw arguments JSON. Deny is evaluated before allow.\n * @param request - { effect, tool, match, note }.\n * @returns the full rule table.\n */",
          },
          {
            kind: "method",
            name: "removeRule",
            signature: "@Remote('removeRule') async removeRule(request: AgentApprovalRemoveRuleRequest): Promise<AgentApprovalRulesResult>",
            summary: "Remove one rule by id (persisted).",
            jsDoc:
              "/**\n * Remove one rule by id.\n * @param request - { id }.\n * @returns the full rule table.\n */",
          },
          {
            kind: "method",
            name: "sessionRecords",
            signature: "@Remote('sessionRecords') async sessionRecords(request: AgentApprovalSessionRecordsRequest): Promise<AgentApprovalSessionRecordsResult>",
            summary: "Fold one live session's audit records out of its own durable log.",
            jsDoc:
              "/**\n * Fold the agent-approval/record events of one live session (chronological) plus the current enabled state. Records follow the session: persisted in its log, restored with it, gone when it is deleted.\n * @param request - { sessionId }.\n * @returns the session's records, or session-not-live.\n */",
          },
          {
            kind: "method",
            name: "directory",
            signature: "@Remote('directory') async directory(): Promise<AgentApprovalDirectoryResult>",
            summary: "Providers/models directory plus the harness default selection, for the Settings pickers.",
            jsDoc:
              "/**\n * List registered providers, their models, and the harness default selection.\n * @returns the picker directory.\n */",
          },
        ],
        types: [
          {
            name: "AgentApprovalRecord",
            declaration:
              "export interface AgentApprovalRecord {\n    readonly at: string;\n    readonly sessionId: string;\n    readonly toolName: string;\n    readonly reason: string;\n    readonly args: string;\n    readonly outcome: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';\n    readonly riskLevel: string;\n    readonly model: string;\n    readonly durationMs: number;\n    readonly childSessionId: string;\n    readonly rationale: string;\n}",
          },
          {
            name: "AgentApprovalModelRoute",
            declaration:
              "export interface AgentApprovalModelRoute {\n    readonly provider: string;\n    readonly model: string;\n}",
          },
          {
            name: "AgentApprovalJevConfig",
            declaration:
              "export interface AgentApprovalJevConfig {\n    readonly apiKey: string;\n    readonly endpoint: string;\n    readonly model: string;\n    readonly confidence: number;\n}",
          },
          {
            name: "AgentApprovalSetJevRequest",
            declaration:
              "export interface AgentApprovalSetJevRequest {\n    readonly apiKey: string;\n    readonly endpoint: string;\n    readonly model: string;\n    readonly confidence: number;\n}",
          },
          {
            name: "AgentApprovalSetJevResult",
            declaration:
              "export type AgentApprovalSetJevResult = { ok: true; value: { readonly jev: AgentApprovalJevConfig } } | { ok: false; error: { code: string; message?: string } };",
          },
          {
            name: "AgentApprovalEnabledSession",
            declaration:
              "export interface AgentApprovalEnabledSession {\n    readonly id: string;\n    readonly title: string;\n    readonly cwd: string;\n}",
          },
          {
            name: "AgentApprovalRule",
            declaration:
              "export interface AgentApprovalRule {\n    readonly id: string;\n    readonly effect: 'allow' | 'deny';\n    readonly tool: string;\n    readonly match: string;\n    readonly note: string;\n    readonly createdAt: string;\n}",
          },
          {
            name: "AgentApprovalRulesResult",
            declaration:
              "export type AgentApprovalRulesResult = { ok: true; value: { readonly rules: readonly AgentApprovalRule[] } } | { ok: false; error: { code: string; message?: string } };",
          },
          {
            name: "AgentApprovalStateValue",
            declaration:
              "export interface AgentApprovalStateValue {\n    readonly model: AgentApprovalModelRoute;\n    readonly jev: AgentApprovalJevConfig;\n    readonly timeoutMs: number;\n    readonly enabledSessions: readonly AgentApprovalEnabledSession[];\n    readonly rules: readonly AgentApprovalRule[];\n}",
          },
          {
            name: "AgentApprovalSessionRecordsRequest",
            declaration:
              "export interface AgentApprovalSessionRecordsRequest {\n    readonly sessionId: string;\n}",
          },
          {
            name: "AgentApprovalSessionRecordsValue",
            declaration:
              "export interface AgentApprovalSessionRecordsValue {\n    readonly records: readonly AgentApprovalRecord[];\n    readonly enabled: boolean;\n}",
          },
          {
            name: "AgentApprovalSessionRecordsResult",
            declaration:
              "export type AgentApprovalSessionRecordsResult = { ok: true; value: AgentApprovalSessionRecordsValue } | { ok: false; error: { code: string; message?: string } };",
          },
          {
            name: "AgentApprovalStateResult",
            declaration:
              "export type AgentApprovalStateResult = { ok: true; value: AgentApprovalStateValue } | { ok: false; error: { code: string; message?: string } };",
          },
        ],
      },
    ],
    events: [],
    objects: [],
  },
};
