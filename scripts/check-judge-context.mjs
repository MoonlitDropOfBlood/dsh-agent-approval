#!/usr/bin/env node
/** Differential and lifecycle checks for the incremental judge context. */

import assert from "node:assert/strict";
import {
  JudgeContextCache,
  applyJudgeContext,
  foldJudgeContext,
  initJudgeContext,
} from "../judge-context.js";

let checks = 0;
function check(name, fn) {
  fn();
  checks += 1;
  console.log("ok   " + name);
}

/** Independent copy of the pre-optimization behavior used as the oracle. */
function trunc(value, n) {
  // Byte-identical to the pre-optimization trunc() in index.js — including
  // the "…[truncated]" marker. An oracle that quietly drops the marker
  // cannot catch the very regression it is meant to catch.
  if (typeof value !== "string") return "";
  return value.length > n ? value.slice(0, n) + "…[truncated]" : value;
}
function legacyUser(events) {
  let first = "";
  const last = [];
  for (const e of events) {
    if (e.type !== "user/message") continue;
    const msg = e.data;
    if (!msg || !msg.source || msg.source.kind !== "user") continue;
    if (!Array.isArray(msg.content)) continue;
    const parts = [];
    for (const block of msg.content) {
      if (block && block.type === "text" && typeof block.text === "string") parts.push(block.text);
    }
    const text = parts.join("\n").trim();
    if (text === "") continue;
    if (first === "") first = text;
    last.push(text);
    if (last.length > 3) last.shift();
  }
  const recent = last.filter((t) => t !== first);
  return { first: trunc(first, 800), recent: recent.map((t) => trunc(t, 800)) };
}

function legacyArgs(events, callId) {
  if (callId === undefined) return undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "tool/call" && e.data.callId === callId) return e.data.arguments;
  }
  return undefined;
}

function user(text, kind = "user") {
  return { type: "user/message", data: { source: { kind }, content: [{ type: "text", text }] } };
}
function call(callId, args) {
  return { type: "tool/call", data: { callId, name: "bash", arguments: args } };
}
function unrelated() {
  return { type: "step/end", data: { turn: 1, step: 1 } };
}

function world(initial = []) {
  const events = initial.slice();
  let w;
  const session = {
    id: "session-test",
    seq: events.length,
    snapshotEvents: () => {
      w.fullSnapshotCalls += 1;
      return events;
    },
  };
  const cache = new JudgeContextCache((s) => s.snapshotEvents());
  w = {
    session,
    cache,
    events,
    fullSnapshotCalls: 0,
    append(event, seq = session.seq) {
      const stamped = { ...event, seq };
      events.push(stamped);
      session.seq += 1;
      cache.observe(session, stamped);
      return stamped;
    },
    emit(event) {
      cache.observe(session, event);
    },
    assertCurrent() {
      assert.deepEqual(cache.recentUserContext(session), legacyUser(events));
      for (const e of events) {
        if (e.type === "tool/call") assert.equal(cache.callArgs(session, e.data.callId), legacyArgs(events, e.data.callId));
      }
    },
  };
  return w;
}

check("cold and hot reads match the legacy fold without repeated snapshots", () => {
  const w = world([user("original task"), call("a", "{\"command\":\"one\"}"), unrelated(), user("follow up")]);
  w.assertCurrent();
  const cold = w.fullSnapshotCalls;
  for (let i = 0; i < 1000; i++) w.assertCurrent();
  assert.equal(w.fullSnapshotCalls, cold, "hot path materialized another full snapshot");
});

check("incremental events, duplicates and eviction fallback are exact", () => {
  const w = world([user("task")]);
  w.assertCurrent();
  w.append(call("dup", "first"));
  w.append(unrelated());
  w.append(call("dup", "last"));
  w.append(user("recent"));
  w.assertCurrent();
  for (let i = 0; i < 40; i++) w.append(call("c" + i, "args" + i));
  w.assertCurrent();
  assert.equal(w.cache.callArgs(w.session, "missing"), undefined);
});

check("seq gaps and seq-less observations force a correct full rebuild", () => {
  const w = world([user("before")]);
  w.assertCurrent();
  w.append(user("after"), w.session.seq + 3);
  assert.deepEqual(w.cache.recentUserContext(w.session), legacyUser(w.events));
  w.emit({ type: "user/message", data: { source: { kind: "user" }, content: [] } });
  assert.deepEqual(w.cache.recentUserContext(w.session), legacyUser(w.events));
});

check("already folded duplicate events are ignored", () => {
  const w = world([user("task")]);
  w.assertCurrent();
  const event = w.append(user("once"));
  w.emit(event);
  w.emit(event);
  assert.deepEqual(w.cache.recentUserContext(w.session), legacyUser(w.events));
});

check("full-text dedupe precedes 800-char truncation", () => {
  const prefix = "x".repeat(800);
  const w = world([user(prefix + "A"), user(prefix + "B"), user("third"), user("fourth")]);
  assert.deepEqual(w.cache.recentUserContext(w.session), legacyUser(w.events));
  assert.equal(w.cache.recentUserContext(w.session).recent.length, 3);
});

check("a truncated user message keeps its truncation marker", () => {
  const long = "y".repeat(1200);
  const w = world([user(long)]);
  const context = w.cache.recentUserContext(w.session);
  assert.equal(context.first.length, 800 + "…[truncated]".length);
  assert.ok(context.first.endsWith("…[truncated]"), "the judge must be able to see that the task text was cut");
  assert.deepEqual(context, legacyUser(w.events));
});

check("captured recent arrays are isolated from later appended messages", () => {
  const w = world([user("first"), user("second")]);
  const captured = w.cache.recentUserContext(w.session);
  w.append(user("third"));
  assert.deepEqual(captured, { first: "first", recent: ["second"] });
  assert.deepEqual(w.cache.recentUserContext(w.session), { first: "first", recent: ["second", "third"] });
});

check("fork-like independent Session objects never share state", () => {
  const parentEvents = [user("inherited"), call("parent", "args")];
  const parent = world(parentEvents);
  const child = world(parentEvents);
  child.session.id = "session-child";
  parent.append(user("parent only"));
  child.assertCurrent();
  assert.deepEqual(child.cache.recentUserContext(child.session), { first: "inherited", recent: [] });
});

check("disposal invalidates the derived entry", () => {
  const w = world([user("task")]);
  w.assertCurrent();
  w.cache.invalidate(w.session);
  w.events.push(user("late"));
  w.session.seq += 1;
  assert.deepEqual(w.cache.recentUserContext(w.session), legacyUser(w.events));
});

check("current-Host projection uses the same pure fold and schema", () => {
  const events = [user("projected"), call("p", "raw")];
  let definition;
  const projections = {
    register(def) {
      definition = def;
    },
    stateOf() {
      let state = definition.init();
      for (const event of events) state = definition.apply(state, event);
      definition.stateSchema.parse(state);
      return state;
    },
  };
  const cache = new JudgeContextCache(() => {
    throw new Error("projection path must not use the legacy reader");
  });
  cache.attach({ inject: (_names, cb) => cb({ sessionProjections: projections }) });
  assert.equal(definition.stateVersion, 1);
  assert.deepEqual(cache.recentUserContext({}), { first: "projected", recent: [] });
  assert.equal(cache.callArgs({}, "p"), "raw");
});

check("50k/100k-event sessions perform one cold fold and zero hot full snapshots", () => {
  for (const size of [50000, 100000]) {
    const events = [user("large session")];
    for (let i = 0; i < size; i++) events.push(unrelated());
    events.push(call("latest", "raw-latest"));
    const w = world(events);
    assert.deepEqual(w.cache.recentUserContext(w.session), { first: "large session", recent: [] });
    assert.equal(w.cache.callArgs(w.session, "latest"), "raw-latest");
    const cold = w.fullSnapshotCalls;
    assert.equal(cold, 1);
    for (let i = 0; i < 1000; i++) {
      w.cache.recentUserContext(w.session);
      w.cache.callArgs(w.session, "latest");
    }
    assert.equal(w.fullSnapshotCalls, cold);
    for (let i = 0; i < 100; i++) w.append(unrelated());
    for (let i = 0; i < 100; i++) w.cache.recentUserContext(w.session);
    assert.equal(w.fullSnapshotCalls, cold, "incremental events unexpectedly triggered a full fold");
  }
});

check("pure fold returns the same reference for unrelated or ignored input", () => {
  const state = initJudgeContext();
  assert.equal(applyJudgeContext(state, unrelated()), state);
  assert.equal(applyJudgeContext(state, user("injected", "tool")), state);
  assert.deepEqual(foldJudgeContext([user("a")]), { firstUser: "a", recentUsersRaw: ["a"], recentToolCalls: [] });
});

console.log("\nall " + checks + " judge-context checks passed");
