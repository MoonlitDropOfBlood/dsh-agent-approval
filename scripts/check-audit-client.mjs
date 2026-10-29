#!/usr/bin/env node
/** Dependency-free checks for the audit client's paged merge and wire shapes. */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../client.js", import.meta.url), "utf8");
let checks = 0;
function ok(name) {
  checks += 1;
  console.log("ok   " + name);
}

const beginMarker = "// ---- audit paging pure helpers";
const endMarker = "// ---- end audit paging pure helpers";
const begin = source.indexOf(beginMarker);
const end = source.indexOf(endMarker);
assert.ok(begin >= 0 && end > begin, "audit helper extraction markers");
const helperSource = source.slice(source.indexOf("\n", begin) + 1, end);
const { createPagedAuditState, mergePagedAuditState, auditErrorKind, planAuditRequest, auditFailurePlan, hostMethodMissing } = new Function(
  helperSource +
    "\nreturn { createPagedAuditState, mergePagedAuditState, auditErrorKind, planAuditRequest, auditFailurePlan, hostMethodMissing };",
)();
assert.equal(typeof createPagedAuditState, "function");
assert.equal(typeof mergePagedAuditState, "function");
assert.equal(typeof auditErrorKind, "function");
assert.equal(typeof planAuditRequest, "function");
assert.equal(typeof auditFailurePlan, "function");
assert.equal(typeof hostMethodMissing, "function");
ok("extract the real pure helpers without React or a bundle transform");

function record(id, at) {
  return { id, at, toolName: "bash", outcome: "allowed-once" };
}

const r0 = record(0, "2026-01-01T00:00:00.000Z");
const r1 = record(1, "2026-01-02T00:00:00.000Z");
const r2 = record(2, "2026-01-02T00:00:00.000Z");
const head = mergePagedAuditState(null, {
  records: [r0, r1, r2],
  enabled: true,
  nextCursor: "before-1",
  syncCursor: "after-1",
}, "initial");
assert.deepEqual(head.order, [2, 1, 0]);
assert.equal(head.beforeCursor, "before-1");
assert.equal(head.enabled, true);
assert.strictEqual(head.rowsById["0"], r0);
assert.strictEqual(head.rowsById["1"], r1);
assert.strictEqual(head.rowsById["2"], r2);
ok("head merge sorts by (at,id) descending and retains record references");

const emptyAfter = mergePagedAuditState(head, {
  records: [],
  enabled: true,
  nextCursor: null,
  syncCursor: "after-2",
}, "after");
assert.strictEqual(emptyAfter, head);
assert.strictEqual(emptyAfter.order, head.order);
assert.strictEqual(emptyAfter.rowsById, head.rowsById);
assert.equal(emptyAfter.beforeCursor, "before-1");
ok("empty unchanged increment returns the identical state and preserves before cursor");

const duplicateAfter = mergePagedAuditState(head, {
  records: [record(2, "2030-01-01T00:00:00.000Z")],
  enabled: true,
  nextCursor: null,
  syncCursor: "after-2",
}, "after");
assert.strictEqual(duplicateAfter, head);
assert.strictEqual(duplicateAfter.rowsById["2"], r2);
ok("duplicate ids neither replace records nor force an update");

const disabled = mergePagedAuditState(head, { records: [], enabled: false }, "after");
assert.notStrictEqual(disabled, head);
assert.strictEqual(disabled.order, head.order);
assert.strictEqual(disabled.rowsById, head.rowsById);
assert.equal(disabled.enabled, false);
ok("enabled-only changes reuse both record collections");

const r3 = record(3, "2025-12-31T00:00:00.000Z");
const older = mergePagedAuditState(head, {
  records: [r3],
  enabled: true,
  nextCursor: "before-2",
  syncCursor: null,
}, "before");
assert.deepEqual(older.order, [2, 1, 0, 3]);
assert.equal(older.beforeCursor, "before-2");
assert.strictEqual(older.rowsById["2"], r2);
assert.strictEqual(older.rowsById["3"], r3);
ok("older pages merge without rebuilding unchanged rows");

const r4 = record(4, "2026-01-03T00:00:00.000Z");
const incremented = mergePagedAuditState(older, {
  records: [r4, record(2, "2030-01-01T00:00:00.000Z")],
  enabled: true,
  nextCursor: "after-drain-next",
  syncCursor: "after-3",
}, "after");
assert.deepEqual(incremented.order, [4, 2, 1, 0, 3]);
assert.equal(incremented.beforeCursor, "before-2");
assert.strictEqual(incremented.rowsById["2"], r2);
assert.strictEqual(incremented.rowsById["3"], r3);
assert.strictEqual(incremented.rowsById["4"], r4);
ok("incremental merge dedupes mixed pages and never consumes drain cursors as before cursors");

assert.match(source, /id:\s*"dsh-agent-approval#agentApproval\/sessionRecordsPage"/);
assert.match(source, /typeof remote\.sessionRecordsPage === "function"/);
assert.match(source, /typeof remote\.sessionRecords !== "function"/);
ok("new Remote descriptor, capability preference and legacy fallback remain present");

// --- behaviour: which request does a poll/button make? -------------------------
assert.equal(planAuditRequest("initial", false), "initial");
assert.equal(planAuditRequest("initial", true), "initial");
assert.equal(planAuditRequest("refresh", false), "initial", "no cursor yet -> read the head");
assert.equal(planAuditRequest("refresh", true), "after", "with a cursor -> drain the appends");
assert.equal(planAuditRequest("resync", true), "initial", "an explicit re-read always reads the head");
assert.equal(planAuditRequest("older", true), "before");
assert.equal(planAuditRequest("older", false), "before");
ok("request planning picks head, drain or older-page per direction");

// --- behaviour: how is a failure classified? -----------------------------------
function failure(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}
assert.equal(auditErrorKind(failure("gateway/invocation-unavailable")), "paging-unavailable");
assert.equal(auditErrorKind(failure("gateway/endpoint-unavailable")), "paging-unavailable");
assert.equal(
  auditErrorKind(failure("gateway/rpc-failed", "no active Remote method exports this endpoint")),
  "paging-unavailable",
  "the gateway's own message is the fallback signal when the code is unknown",
);
assert.equal(auditErrorKind(failure("cursor-stale")), "cursor-reset");
assert.equal(auditErrorKind(failure("invalid-cursor")), "cursor-reset");
assert.equal(auditErrorKind(failure("gateway/rpc-failed", "socket closed")), "transient");
assert.equal(auditErrorKind(failure(undefined, "boom")), "transient");
assert.equal(auditErrorKind(null), "transient");
ok("failure classification separates old-Host, stale-cursor and transient errors");

// --- behaviour: what does the component do after each failure? ----------------
const oldHostPlan = auditFailurePlan(failure("gateway/invocation-unavailable"));
assert.equal(oldHostPlan.legacy, true, "an old Host must switch to the legacy read");
assert.equal(oldHostPlan.resetRows, false);
assert.equal(oldHostPlan.resetCursor, false);

const stalePlan = auditFailurePlan(failure("cursor-stale"));
assert.equal(stalePlan.legacy, false);
assert.equal(stalePlan.resetRows, true, "the physical ids are meaningless after a rewrite");
assert.equal(stalePlan.resetCursor, true);
assert.match(stalePlan.note, /重新同步/);

const transientPlan = auditFailurePlan(failure("gateway/rpc-failed", "socket closed"));
assert.equal(transientPlan.legacy, false);
assert.equal(transientPlan.resetRows, false, "a transient failure must not throw the rows away");
assert.equal(transientPlan.resetCursor, true, "but it must drop the cursor that may be the cause");
assert.match(transientPlan.note, /socket closed/);
ok("the failure plan keeps the rows on a transient error and resets them on a stale cursor");

// --- behaviour: the old-Host fallback must be reachable ------------------------
// The client gateway installs EVERY client-contributed descriptor as a namespace
// method, so `typeof remote.sessionRecordsPage === "function"` is always true and
// can never detect an old Host. The fallback must therefore key off the gateway
// error, and the legacy read must be reachable from the failure path.
assert.match(source, /modeRef\.current = "legacy"/);
assert.match(source, /auditFailurePlan\(error\)/);
assert.match(source, /if \(plan\.legacy\)/);
assert.match(source, /await loadLegacy\(\)/);
assert.match(source, /const loadLegacy = async function \(\)/);
assert.match(source, /remote\.sessionRecords\(\{ sessionId: sessionId \}\)/);
ok("an old Host without sessionRecordsPage falls back to the legacy full read");

// --- behaviour: every failure mode can recover --------------------------------
// cursor-stale: drop the physical cursors AND the rows (the ids are meaningless
// after a rewrite). Any other failure: drop only the append cursor so the next
// poll re-reads the head instead of retrying a bad cursor forever.
assert.match(source, /if \(plan\.resetRows\)[\s\S]*?stateRef\.current = null;[\s\S]*?setState\(null\);/);
assert.match(source, /if \(plan\.resetCursor\) syncCursorRef\.current = null;/);
assert.match(source, /clearErrorNote\(\)/);
ok("cursor-stale resets everything while a transient failure only drops the cursor");

// --- behaviour: the error note must not survive a successful load -------------
assert.match(source, /noteKindRef\.current = "error"/);
assert.match(source, /if \(noteKindRef\.current === "error"\)/);
ok("a stale error note is cleared once the tab reads successfully again");

// --- behaviour: the refresh button reconciles instead of only draining ---------
assert.match(source, /resync: function \(\) \{ return run\("resync"\); \}/);
assert.match(source, /if \(direction === "resync"\) syncCursorRef\.current = null;/);
assert.match(source, /operations\.resync\(\)/);
ok("the refresh button re-reads the head so a drifted client can reconcile");

assert.match(source, /remote\.sessionRecordsPage\(\{\s*sessionId: sessionId,\s*limit: AUDIT_PAGE_LIMIT,\s*\}\)/s);
assert.match(source, /remote\.sessionRecordsPage\(\{\s*sessionId: sessionId,\s*limit: AUDIT_PAGE_LIMIT,\s*before: beforeCursor,\s*\}\)/s);
assert.match(source, /remote\.sessionRecordsPage\(\{\s*sessionId: sessionId,\s*limit: AUDIT_PAGE_LIMIT,\s*after: afterCursor,\s*\}\)/s);
assert.match(source, /const AUDIT_PAGE_LIMIT = 100;/);
assert.match(source, /while \(afterCursor !== null\)/);
assert.match(source, /afterCursor = typeof page\.nextCursor === "string"/);
ok("head, before and after requests use bounded mutually exclusive shapes and drain nextCursor");

assert.match(source, /typeof React\.memo === "function"/);
assert.match(source, /memoAuditComponent\(function ApprovalAuditRow/);
assert.match(source, /const whitelistRecord = React\.useCallback/);
assert.match(source, /useSession\(function \(s\) \{ return s && s\.sessionId \? s\.sessionId : ""; \}\)/);
assert.match(source, /key: pagedState \? r\.id/);
assert.match(source, /if \(!isCurrent\(\) \|\| inFlightRef\.current \|\| sessionId === ""\) return;/);
assert.match(source, /generationRef\.current = generation \+ 1;/);
assert.equal(source.includes("?."), false);
assert.equal(source.includes("??"), false);
ok("memo rows, leaf session selection, stable paged keys and lifecycle guards are statically present");

assert.match(source, /error\.code = err\.code;/);
assert.equal(source.includes("import "), false, "the client bundle must not use import");
ok("the error code of both envelope layers reaches the caller");

// --- behaviour: an outdated Host is detected from the gateway error ----------
assert.equal(hostMethodMissing({ code: "gateway/invocation-unavailable" }), true);
assert.equal(hostMethodMissing({ code: "gateway/method-unavailable" }), true);
assert.equal(hostMethodMissing({ code: "gateway/service-unavailable" }), true);
assert.equal(hostMethodMissing({ message: "no active Remote method exports this endpoint" }), true);
assert.equal(hostMethodMissing({ code: "gateway/internal" }), false);
assert.equal(hostMethodMissing({ code: "gateway/cancelled" }), false);
assert.equal(hostMethodMissing(null), false);
assert.equal(auditErrorKind({ code: "gateway/method-unavailable" }), "paging-unavailable");
assert.equal(auditErrorKind({ code: "gateway/internal" }), "transient");
ok("an outdated Host is recognised from the gateway error, never from a typeof probe");

// --- behaviour: the merged view stays bounded -------------------------------
// A long-lived tab must not accumulate (and re-render) every approval of the
// session: only the newest drained rows are kept.
const limit = 500;
let grown = createPagedAuditState();
for (let index = 0; index < limit + 120; index += 1) {
  grown = mergePagedAuditState(grown, {
    records: [{ id: index, at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString() }],
    enabled: true,
    nextCursor: "after",
  }, "after");
}
assert.equal(grown.order.length, limit, "the drained rows are capped");
assert.equal(grown.order[0], limit + 119, "the newest drained row stays on top");
// The rows the user loaded explicitly are never dropped by the cap.
const withHead = mergePagedAuditState(grown, {
  records: [{ id: 9000, at: "2025-01-01T00:00:00.000Z" }],
  enabled: true,
  nextCursor: "before-1",
}, "before");
assert.equal(withHead.order.length, limit + 1, "an explicitly loaded page survives the cap");
assert.equal(withHead.order[withHead.order.length - 1], 9000);
ok("the incremental drain is capped while explicitly loaded pages survive");

// --- behaviour: a legacy read result is never mistaken for a paged state ----
const legacyState = { records: [{ at: "2026-01-01T00:00:00.000Z", toolName: "bash" }], enabled: true };
const merged = mergePagedAuditState(legacyState, { records: [record(1, "2026-01-02T00:00:00.000Z")], enabled: true }, "after");
assert.deepEqual(merged.order, [1], "a legacy state object must not throw and must start fresh");
ok("a legacy state object never breaks the merge");

console.log("\nall " + checks + " audit-client checks passed");
