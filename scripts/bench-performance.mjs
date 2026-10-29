#!/usr/bin/env node
/** Local opt-in benchmark; correctness suites assert complexity, this prints timings. */

import { performance } from "node:perf_hooks";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JudgeContextCache } from "../judge-context.js";
import { AuditRecordStore } from "../audit-store.js";

function percentile(values, p) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] || 0;
}
function ms(value) {
  return Number(value.toFixed(3));
}

const events = [{ type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "bench" }] } }];
for (let i = 0; i < 50000; i++) events.push({ type: "step/end", data: { turn: 1, step: i } });
events.push({ type: "tool/call", data: { callId: "latest", name: "bash", arguments: "{}" } });
const session = { id: "session-bench", seq: events.length, snapshotEvents: () => events };
const context = new JudgeContextCache((s) => s.snapshotEvents());
let t0 = performance.now();
context.recentUserContext(session);
const contextCold = performance.now() - t0;
const contextHot = [];
for (let i = 0; i < 1000; i++) {
  t0 = performance.now();
  context.recentUserContext(session);
  context.callArgs(session, "latest");
  contextHot.push(performance.now() - t0);
}
console.log("judge context E=" + events.length + ": cold=" + ms(contextCold) + "ms, hot p50=" + ms(percentile(contextHot, 0.5)) + "ms, p95=" + ms(percentile(contextHot, 0.95)) + "ms");

const dir = await mkdtemp(join(tmpdir(), "aapr-bench-"));
try {
  const file = join(dir, "agent-approval.jsonl");
  const rows = [];
  for (let i = 0; i < 2000; i++) {
    rows.push(JSON.stringify({
      at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
      toolName: "bash",
      reason: "bench",
      args: "{}",
      outcome: "allowed-once",
      riskLevel: "low",
      model: "llm(bench)",
      durationMs: 1,
      childSessionId: "",
      rationale: "bench " + i,
      mode: "review",
    }));
  }
  await writeFile(file, rows.join("\n") + "\n", "utf8");
  const store = new AuditRecordStore((sid, row) => ({
    at: String(row.at), sessionId: sid, toolName: String(row.toolName), reason: String(row.reason),
    args: String(row.args), outcome: row.outcome, riskLevel: String(row.riskLevel), model: String(row.model),
    durationMs: Number(row.durationMs) || 0, childSessionId: String(row.childSessionId),
    rationale: String(row.rationale), mode: row.mode === "review" ? "review" : "escalation",
  }));
  t0 = performance.now();
  await store.read(session, file);
  const auditCold = performance.now() - t0;
  const auditHot = [];
  for (let i = 0; i < 100; i++) {
    t0 = performance.now();
    await store.read(session, file);
    auditHot.push(performance.now() - t0);
  }
  t0 = performance.now();
  const page = await store.page(session, file, { limit: 100 });
  const pageWarm = performance.now() - t0;
  console.log("audit A=2000: cold=" + ms(auditCold) + "ms, unchanged read p50=" + ms(percentile(auditHot, 0.5)) + "ms, p95=" + ms(percentile(auditHot, 0.95)) + "ms, warm page=" + ms(pageWarm) + "ms, page rows=" + page.records.length);
} finally {
  await rm(dir, { recursive: true, force: true });
}
