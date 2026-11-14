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

/**
 * A minimal stand-in for the Host's durable-session seam (`ctx.sessionPersistence`):
 * `stat(id)` proves the session exists and names its log revision, `open(id,
 * "read")` hands out a read handle whose `read(0)` returns the persisted
 * events, and `resolveCurrentLog(id)` locates the session's own log file — the
 * audit sidecar lives in that directory. Every call is counted so the
 * regression can prove that an unchanged revision is never re-read.
 */
function mockPersistence(state) {
  return {
    async stat(id) {
      state.statCount += 1;
      const entry = state.sessions.get(id);
      return entry === undefined ? undefined : entry.stat;
    },
    async open(id) {
      const entry = state.sessions.get(id);
      if (entry === undefined) throw new Error("no such session: " + id);
      state.openCount += 1;
      let closed = false;
      return {
        async read(offset) {
          state.readCount += 1;
          if (closed) throw new Error("read on a closed handle");
          return { events: entry.events.slice(offset) };
        },
        async close() {
          closed = true;
          state.closeCount += 1;
        },
      };
    },
    async resolveCurrentLog(id) {
      return state.logPaths.get(id);
    },
  };
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

    // An inherited-review child has no own _enabled entry, but both audit
    // endpoints must still report the effective mode instead of displaying
    // the contradictory "not enabled" badge above real review records.
    inst._enabled = new Map();
    inst._reviewOptOut = new Set();
    inst._reviewInherited = new Set([session.id]);
    const inheritedLegacy = await inst.sessionRecords({ sessionId: session.id });
    assert.equal(inheritedLegacy.ok, true);
    assert.equal(inheritedLegacy.value.enabled, true);
    const inheritedPage = strictPage(await inst.sessionRecordsPage({ sessionId: session.id, limit: 1 }));
    assert.equal(inheritedPage.ok, true);
    assert.equal(inheritedPage.value.enabled, true);
    inst._reviewOptOut.add(session.id);
    const optedOut = await inst.sessionRecords({ sessionId: session.id });
    assert.equal(optedOut.ok, true);
    assert.equal(optedOut.value.enabled, false);
    inst._reviewOptOut.delete(session.id);
    ok("legacy and paged audit state both recognize inherited review and its explicit opt-out");

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
    oracleInst._reviewOptOut = new Set();
    oracleInst._reviewInherited = new Set();
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

    // ---- v1.12.5: a session that is no longer live must still be readable ---
    //
    // A finished subagent has no live agent any more, but its audit sidecar
    // and its durable log are still there. The Host must read them instead of
    // refusing with "that session is not live right now".
    const coldDir = join(dir, "cold");
    await mkdir(coldDir, { recursive: true });
    const coldId = "session-cold-child";
    const coldFile = join(coldDir, "agent-approval.jsonl");
    await writeFile(
      coldFile,
      [entry(coldId, 0, "2026-02-01T00:00:00.000Z"), entry(coldId, 1, "2026-02-02T00:00:00.000Z")]
        .map((row) => JSON.stringify(row))
        .join("\n") + "\n",
      "utf8",
    );
    // The delegated-child shape: the Host's delegation pin (danger-full-access
    // + never), the preset identity derived from it, and OUR inheritance
    // marker for the inherited 自动审查 coverage.
    const delegatedEvents = [
      { type: "sandbox/mode", data: { mode: "danger-full-access", source: "delegation" } },
      { type: "approval/policy", data: { policy: "never", source: "delegation" } },
      { type: "permission/preset", data: { preset: "danger-full-access" } },
      { type: "permission/preset", data: { preset: "agent-review", source: "agent-approval/inherited-review" } },
    ];
    const state = {
      sessions: new Map(),
      logPaths: new Map(),
      statCount: 0,
      openCount: 0,
      readCount: 0,
      closeCount: 0,
    };
    state.sessions.set(coldId, {
      stat: {
        header: { id: coldId, origin: "subagent", parentSession: "session-parent" },
        revision: "rev-1",
      },
      events: delegatedEvents,
    });
    state.logPaths.set(coldId, join(coldDir, "session.jsonl.zstd"));
    const persistence = mockPersistence(state);

    const cold = Object.create(AgentApprovalService.prototype);
    cold.ctx = {
      // The agent is gone: this is a disposed session.
      agents: { get: () => undefined },
      get: (name) => (name === "sessionPersistence" ? persistence : undefined),
    };
    cold._enabled = new Map();
    cold._reviewInherited = new Set();
    cold._reviewOptOut = new Set();
    cold._auditStore = new AuditRecordStore((sid, row) => cold._recordShape(sid, row));

    const coldLegacy = await cold.sessionRecords({ sessionId: coldId });
    assert.equal(coldLegacy.ok, true);
    assert.equal(coldLegacy.value.records.length, 2);
    assert.equal(coldLegacy.value.records[0].id, undefined);
    assert.deepEqual(coldLegacy.value.records.map((row) => row.rationale), ["r-0", "r-1"]);
    // The inherited marker is the durable proof of the coverage.
    assert.equal(coldLegacy.value.enabled, true);
    const coldPage = strictPage(await cold.sessionRecordsPage({ sessionId: coldId, limit: 10 }));
    assert.equal(coldPage.ok, true);
    assert.equal(coldPage.value.records.length, 2);
    assert.equal(coldPage.value.enabled, true);
    // The sidecar is located through the CURRENT Host's `resolveCurrentLog(id)`
    // — i.e. the session's own directory, not the plugin-owned fallback.
    const coldFacade = cold._historicalAudit.get(coldId).facade;
    assert.equal(await cold._recordsFileOf(coldFacade), coldFile);
    // Reading history must never re-arm a disposed session.
    assert.equal(cold._enabled.size, 0);
    assert.equal(cold._reviewInherited.size, 0);
    assert.equal(cold._reviewOptOut.size, 0);
    ok("a disposed session's legacy and paged audit reads work and report the inherited review");

    // The revision did not change: the poll must not re-open or re-read the
    // historical log.
    assert.equal(state.openCount, 1);
    assert.equal(state.readCount, 1);
    await cold.sessionRecords({ sessionId: coldId });
    await cold.sessionRecordsPage({ sessionId: coldId, limit: 10 });
    assert.equal(state.openCount, 1);
    assert.equal(state.readCount, 1);
    // Every read handle is closed again.
    assert.equal(state.closeCount, state.openCount);
    ok("an unchanged revision reuses the cached history instead of re-reading it");

    // The revision changed: the history is re-read, and a LATER explicit
    // preset (the opt-out) turns the reported state off while the records
    // stay readable.
    state.sessions.get(coldId).stat = {
      header: { id: coldId, origin: "subagent", parentSession: "session-parent" },
      revision: "rev-2",
    };
    state.sessions.get(coldId).events = delegatedEvents.concat([
      { type: "permission/preset", data: { preset: "danger-full-access" } },
    ]);
    const coldAfter = await cold.sessionRecords({ sessionId: coldId });
    assert.equal(state.openCount, 2);
    assert.equal(state.readCount, 2);
    assert.equal(state.closeCount, state.openCount);
    assert.equal(coldAfter.ok, true);
    assert.equal(coldAfter.value.enabled, false);
    assert.equal(coldAfter.value.records.length, 2);
    ok("a changed revision refreshes the history and honors a later explicit opt-out");

    // An own preset covers the session too (both of ours). It has no sidecar
    // of its own, so it yields an empty — but successful — read.
    const ownDir = join(dir, "own");
    await mkdir(ownDir, { recursive: true });
    const ownId = "session-own-preset";
    state.sessions.set(ownId, {
      stat: { header: { id: ownId }, revision: "rev-own" },
      events: [{ type: "permission/preset", data: { preset: "agent-approval" } }],
    });
    state.logPaths.set(ownId, join(ownDir, "own.jsonl.zstd"));
    const own = await cold.sessionRecords({ sessionId: ownId });
    assert.equal(own.ok, true);
    assert.equal(own.value.enabled, true);
    assert.deepEqual(own.value.records, []);
    // The Host's delegated bootstrap alone is not an explicit exit.
    const bootDir = join(dir, "boot");
    await mkdir(bootDir, { recursive: true });
    const bootId = "session-bootstrap-only";
    state.sessions.set(bootId, {
      stat: {
        header: { id: bootId, origin: "subagent", parentSession: "session-parent" },
        revision: "rev-boot",
      },
      events: delegatedEvents.slice(0, 3),
    });
    state.logPaths.set(bootId, join(bootDir, "boot.jsonl.zstd"));
    const boot = await cold.sessionRecords({ sessionId: bootId });
    assert.equal(boot.ok, true);
    assert.equal(boot.value.enabled, false);
    assert.equal(cold._reviewOptOut.size, 0);
    ok("own presets cover a historical session while the delegated bootstrap does not opt out");

    // A session that does not exist must NOT look like an empty audit.
    const absentSession = await cold.sessionRecords({ sessionId: "session-nope" });
    assert.equal(absentSession.ok, false);
    assert.equal(absentSession.error.code, "session-not-found");
    const absentSessionPage = await cold.sessionRecordsPage({ sessionId: "session-nope" });
    assert.equal(absentSessionPage.ok, false);
    assert.equal(absentSessionPage.error.code, "session-not-found");
    // An old Host without the persistence seam keeps the original refusal.
    const oldHost = Object.create(AgentApprovalService.prototype);
    oldHost.ctx = { agents: { get: () => undefined }, get: () => undefined };
    const oldHostResult = await oldHost.sessionRecords({ sessionId: coldId });
    assert.equal(oldHostResult.ok, false);
    assert.equal(oldHostResult.error.code, "session-not-live");
    ok("a missing session is an error and an old Host keeps its session-not-live fallback");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  console.log("\nall " + checks + " session-records checks passed");
}

await main();
