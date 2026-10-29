#!/usr/bin/env node
/** Integration checks: real Service methods + audit store + strict Typert results. */

import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentApprovalService } from "../index.js";
import { AuditRecordStore } from "../audit-store.js";
import { TYPERT } from "../typert.host.js";

let checks = 0;
function ok(name) {
  checks += 1;
  console.log("ok   " + name);
}

function entry(sessionId, i, at) {
  return {
    at,
    sessionId,
    toolName: "bash",
    reason: "test",
    args: "{\"i\":" + i + "}",
    outcome: "allowed-once",
    riskLevel: "low",
    model: "llm(test)",
    durationMs: i,
    childSessionId: "",
    rationale: "r-" + i,
    mode: "review",
  };
}

const invocation = TYPERT.invocations.find((row) => row.method === "sessionRecordsPage");
function strictPage(result) {
  return invocation.result.create().parse(result);
}

/**
 * The pre-change reader, kept verbatim as the compatibility oracle: it read
 * the whole file text, parsed every complete JSON line with a string `at`, and
 * stably sorted by `at`. The incremental index must reproduce it exactly.
 */
function legacyOracle(text, shape) {
  const out = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && typeof parsed.at === "string") {
        out.push(shape(parsed));
      }
    } catch (e) {
      /* skip the corrupt line */
    }
  }
  out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return out;
}

async function main() {
  const dir = await mkdtemp(join(tmpdir(), "aapr-session-records-"));
  try {
    const session = { id: "session-integration" };
    const file = join(dir, "agent-approval.jsonl");
    const initial = [];
    for (let i = 0; i < 250; i++) {
      const at = i < 100 ? "2026-01-01T00:00:00.000Z" : new Date(Date.UTC(2026, 0, 1, 0, 0, i - 99)).toISOString();
      initial.push(entry(session.id, i, at));
    }
    await writeFile(file, initial.map((row) => JSON.stringify(row)).join("\n") + "\n{bad json}\n", "utf8");

    const inst = Object.create(AgentApprovalService.prototype);
    inst.ctx = { agents: { get: (id) => (id === session.id ? { session } : undefined) } };
    inst._enabled = new Map([[session.id, { mode: "review" }]]);
    inst._auditStore = new AuditRecordStore((sid, row) => inst._recordShape(sid, row));
    inst._recordsFileOf = async () => file;

    const legacy = await inst.sessionRecords({ sessionId: session.id });
    assert.equal(legacy.ok, true);
    assert.equal(legacy.value.records.length, 250);
    assert.equal(legacy.value.records[0].id, undefined);
    assert.equal(legacy.value.records[0].rationale, "r-0");
    assert.equal(legacy.value.enabled, true);
    ok("legacy sessionRecords keeps its full id-less ascending shape");

    const first = strictPage(await inst.sessionRecordsPage({ sessionId: session.id, limit: 100 }));
    assert.equal(first.ok, true);
    assert.equal(first.value.records.length, 100);
    assert.equal(first.value.nextCursor !== null, true);
    assert.equal(first.value.syncCursor !== null, true);
    assert.equal(first.value.records[0].rationale, "r-249");
    assert.equal(new Set(first.value.records.map((row) => row.id)).size, 100);
    ok("first page is bounded, descending, strict and stably identified");

    const paged = first.value.records.slice();
    let before = first.value.nextCursor;
    let beforeResponse;
    while (before !== null) {
      beforeResponse = strictPage(await inst.sessionRecordsPage({ sessionId: session.id, limit: 100, before }));
      assert.equal(beforeResponse.ok, true);
      assert.equal(beforeResponse.value.syncCursor, null);
      paged.push(...beforeResponse.value.records);
      before = beforeResponse.value.nextCursor;
    }
    assert.equal(paged.length, 250);
    assert.deepEqual(paged.map((row) => row.rationale), legacy.value.records.map((row) => row.rationale).reverse());
    ok("before traversal matches legacy order with no duplicate or omission");

    const sync = first.value.syncCursor;
    await appendFile(file, JSON.stringify(entry(session.id, 250, "2025-01-01T00:00:00.000Z")) + "\n", "utf8");
    await appendFile(file, JSON.stringify(entry(session.id, 251, "2027-01-01T00:00:00.000Z")) + "\n", "utf8");
    const increment = strictPage(await inst.sessionRecordsPage({ sessionId: session.id, limit: 100, after: sync }));
    assert.equal(increment.ok, true);
    assert.deepEqual(increment.value.records.map((row) => row.rationale), ["r-250", "r-251"]);
    assert.equal(increment.value.nextCursor, null);
    ok("after returns backdated and newer appends exactly once");

    // The original before chain is a fixed head: backdated r-250 cannot enter it.
    const oldSecond = strictPage(await inst.sessionRecordsPage({ sessionId: session.id, limit: 100, before: first.value.nextCursor }));
    assert.equal(oldSecond.value.records.some((row) => row.rationale === "r-250"), false);
    assert.equal(oldSecond.value.records[0].rationale, "r-149");
    ok("old before cursor remains on its fixed snapshot after append");

    const missing = await inst.sessionRecordsPage({ sessionId: "session-missing", limit: 100 });
    assert.equal(missing.ok, false);
    assert.equal(missing.error.code, "session-not-live");
    const invalid = await inst.sessionRecordsPage({ sessionId: "" });
    assert.equal(invalid.ok, false);
    assert.equal(invalid.error.code, "invalid-session");
    ok("live-session validation matches the legacy Remote");

    // Differential check: the incremental reader must reproduce the previous
    // full-text reader exactly, for every adversarial file shape.
    const oracleDir = join(dir, "oracle");
    await mkdir(oracleDir, { recursive: true });
    const oracleSession = { id: "session-oracle" };
    const oracleInst = Object.create(AgentApprovalService.prototype);
    oracleInst.ctx = { agents: { get: (id) => (id === oracleSession.id ? { session: oracleSession } : undefined) } };
    oracleInst._enabled = new Map();
    oracleInst._auditStore = new AuditRecordStore((sid, row) => oracleInst._recordShape(sid, row));
    const oracleFile = join(oracleDir, "agent-approval.jsonl");
    oracleInst._recordsFileOf = async () => oracleFile;

    const row = (i, at) => entry(oracleSession.id, i, at);
    const cases = [
      { name: "normal file", body: [row(0, "2026-01-01T00:00:00.000Z"), row(1, "2026-01-02T00:00:00.000Z")].map((r) => JSON.stringify(r)).join("\n") + "\n" },
      { name: "no trailing newline", body: [row(0, "2026-01-01T00:00:00.000Z"), row(1, "2026-01-02T00:00:00.000Z")].map((r) => JSON.stringify(r)).join("\n") },
      { name: "empty file", body: "" },
      { name: "corrupt and blank lines", body: JSON.stringify(row(0, "2026-01-01T00:00:00.000Z")) + "\n{not json}\n\n   \r\n" + JSON.stringify(row(1, "2026-01-02T00:00:00.000Z")) + "\n" },
      { name: "truncated last line", body: JSON.stringify(row(0, "2026-01-01T00:00:00.000Z")) + "\n" + JSON.stringify(row(1, "2026-01-02T00:00:00.000Z")).slice(0, 20) },
      { name: "duplicate lines", body: JSON.stringify(row(0, "2026-01-01T00:00:00.000Z")) + "\n" + JSON.stringify(row(0, "2026-01-01T00:00:00.000Z")) + "\n" },
      { name: "out of order timestamps", body: [row(0, "2026-01-05T00:00:00.000Z"), row(1, "2026-01-01T00:00:00.000Z"), row(2, "2026-01-05T00:00:00.000Z")].map((r) => JSON.stringify(r)).join("\n") + "\n" },
      { name: "missing at field", body: JSON.stringify({ toolName: "bash" }) + "\n" + JSON.stringify(row(0, "2026-01-01T00:00:00.000Z")) + "\n" },
      { name: "crlf line endings", body: JSON.stringify(row(0, "2026-01-01T00:00:00.000Z")) + "\r\n" + JSON.stringify(row(1, "2026-01-02T00:00:00.000Z")) + "\r\n" },
    ];
    for (const testCase of cases) {
      await writeFile(oracleFile, testCase.body, "utf8");
      const actual = await oracleInst.sessionRecords({ sessionId: oracleSession.id });
      assert.equal(actual.ok, true);
      const expected = legacyOracle(testCase.body, (parsed) => oracleInst._recordShape(oracleSession.id, parsed));
      assert.deepEqual(actual.value.records, expected, "legacy mismatch for: " + testCase.name);
    }
    ok("legacy sessionRecords reproduces the previous full-text reader on every adversarial file shape");

    // A missing sidecar must still resolve to an empty list, never a throw.
    oracleInst._recordsFileOf = async () => join(oracleDir, "absent.jsonl");
    const absent = await oracleInst.sessionRecords({ sessionId: oracleSession.id });
    assert.equal(absent.ok, true);
    assert.deepEqual(absent.value.records, []);
    ok("a missing audit file still yields an empty legacy list");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  console.log("\nall " + checks + " session-records checks passed");
}

await main();
