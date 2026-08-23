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

const stateValueSchema = z
  .object({
    model: modelRouteSchema,
    timeoutMs: z.number(),
    enabledSessions: z.array(z.string()).readonly(),
    records: z.array(recordSchema).readonly(),
  })
  .readonly();

const setModelValueSchema = z
  .object({
    model: modelRouteSchema,
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

const clearRecordsValueSchema = z
  .object({
    cleared: z.boolean(),
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
const setTimeoutResultSchema = okResult(setTimeoutValueSchema);
const toggleResultSchema = okResult(toggleValueSchema);
const clearRecordsResultSchema = okResult(clearRecordsValueSchema);
const directoryResultSchema = okResult(directoryValueSchema);

// ---- per-invocation parameter schemas ----------------------------------------

const _agentApproval_setModel_parameter_0$schema = z.object({
  provider: z.string(),
  model: z.string(),
});

const _agentApproval_setApprovalTimeout_parameter_0$schema = z.object({
  timeoutMs: z.number(),
});

const _agentApproval_toggle_parameter_0$schema = z.object({
  sessionId: z.string(),
  on: z.boolean(),
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
          },
        },
      ],
      result: {
        mode: "strict",
        typeSymbol: "dsh-agent-approval#AgentApprovalSetModelResult",
        schema: setModelResultSchema,
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
          },
        },
      ],
      result: {
        mode: "strict",
        typeSymbol: "dsh-agent-approval#AgentApprovalSetTimeoutResult",
        schema: setTimeoutResultSchema,
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
          },
        },
      ],
      result: {
        mode: "strict",
        typeSymbol: "dsh-agent-approval#AgentApprovalToggleResult",
        schema: toggleResultSchema,
      },
      sourceLocation: { file: "index.js", line: 1, column: 1 },
    },
    {
      id: "dsh-agent-approval#agentApproval/clearRecords",
      service: "agentApproval",
      namespace: "agentApproval",
      method: "clearRecords",
      invocation: { kind: "direct" },
      parameters: [],
      result: {
        mode: "strict",
        typeSymbol: "dsh-agent-approval#AgentApprovalClearRecordsResult",
        schema: clearRecordsResultSchema,
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
      },
      sourceLocation: { file: "index.js", line: 1, column: 1 },
    },
  ],
  model: {
    services: [
      {
        description:
          "Agent-approval permission mode service: pins enabled sessions to a workspace-write base, judges every sandbox escalation with an independent approval subagent (fail closed), and exposes model config plus an audit log to the DeepSeek Harness web UI.",
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
            summary: "Snapshot for the Settings page and the composer toggle.",
            jsDoc:
              "/**\n * Return the judge model route, timeout, enabled session ids, and the latest audit records.\n * @returns success or a business failure.\n */",
          },
          {
            kind: "method",
            name: "setModel",
            signature: "@Remote('setModel') async setModel(request: AgentApprovalSetModelRequest): Promise<AgentApprovalSetModelResult>",
            summary: "Set the judge model route (empty strings = inherit the requesting session's).",
            jsDoc:
              "/**\n * Set provider/model used by the approval subagent; empty strings clear the override.\n * @param request - { provider, model }.\n * @returns the stored route.\n */",
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
            name: "clearRecords",
            signature: "@Remote('clearRecords') async clearRecords(): Promise<AgentApprovalClearRecordsResult>",
            summary: "Clear the in-memory audit records.",
            jsDoc:
              "/**\n * Clear the in-memory audit records.\n * @returns { cleared: true }.\n */",
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
            name: "AgentApprovalStateValue",
            declaration:
              "export interface AgentApprovalStateValue {\n    readonly model: AgentApprovalModelRoute;\n    readonly timeoutMs: number;\n    readonly enabledSessions: readonly string[];\n    readonly records: readonly AgentApprovalRecord[];\n}",
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
