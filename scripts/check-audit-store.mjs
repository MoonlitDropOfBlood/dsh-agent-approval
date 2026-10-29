import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendFile,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { AuditRecordStore } from "../audit-store.js";

/*
 * Contract exercised here (also documented in audit-store.js):
 *   read(session, path) -> snapshot { records(with id), generation, lineCount,
 *     byteSize, pendingBytes, filePath, syncCursor }; records are ascending
 *     (at, physical line). legacyRecords(snapshot) strips id for the old wire.
 *   page(..., {limit,before,after}) -> {records,nextCursor,syncCursor}.
 *     No cursor / before: newest first and then older, with a fixed head.
 *     after: physical-line order, including out-of-order `at`, for draining.
 *   Bad complete lines consume ids; unterminated final lines stay pending.
 *   Invalid/wrong-session cursors -> invalid-cursor; rebuilds -> cursor-stale.
 */

const BASE_AT = "2026-01-01T00:00:00.000Z";

function at(index) {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, 0, index)).toISOString();
}

function entry(index, timestamp = at(index), text = `record-${index}`) {
  return { at: timestamp, text, toolName: "bash" };
}

function jsonl(records) {
  return records.map((record) => `${JSON.stringify(record)}\n`).join("");
}

function shapeRecord(sessionId, parsed) {
  // This deliberately resembles the existing Host's complete plain shape and
  // does not add an id of its own. The store owns the physical id.
  return {
    at: String(parsed.at),
    sessionId: String(sessionId),
    text: String(parsed.text),
    toolName: String(parsed.toolName),
  };
}

function newStore(options) {
  return new AuditRecordStore(shapeRecord, options);
}

async function fixture(t, name = "records.jsonl") {
  const directory = await mkdtemp(join(tmpdir(), "dsh-audit-store-"));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, file: join(directory, name) };
}

function ids(records) {
  return records.map((record) => record.id);
}

function texts(records) {
  return records.map((record) => record.text);
}

function range(count, start = 0) {
  return Array.from({ length: count }, (_, index) => index + start);
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error && error.code, code, error && error.stack);
    return true;
  });
}

function decodeCursor(cursor) {
  return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
}

function countedIo() {
  const counts = {
    fullReads: 0,
    rangeReads: 0,
    rangeBytes: 0,
    parses: 0,
  };
  const fs = {
    stat: (...args) => stat(...args),
    readFile: async (...args) => {
      counts.fullReads += 1;
      return readFile(...args);
    },
    open: async (...args) => {
      const handle = await open(...args);
      return {
        read: async (...readArgs) => {
          counts.rangeReads += 1;
          const result = await handle.read(...readArgs);
          counts.rangeBytes += result.bytesRead;
          return result;
        },
        close: () => handle.close(),
      };
    },
  };
  const parse = (text) => {
    counts.parses += 1;
    return JSON.parse(text);
  };
  return { counts, options: { fs, parse } };
}

/**
 * A store whose `stat` always reports the very same values — the situation a
 * rapid in-place rewrite produces on Windows/NTFS, where the timestamp of the
 * rewritten file can be identical to the previous one (measured: 135 of 200
 * rapid rewrites reported the same mtimeMs). Only the content differs.
 */
function frozenStatIo() {
  const counts = { fullReads: 0, rangeReads: 0, rangeBytes: 0, parses: 0, stats: 0 };
  let frozen = null;
  const fs = {
    stat: async (...args) => {
      counts.stats += 1;
      const real = await stat(...args);
      if (frozen === null) frozen = { ...real };
      return { ...real, ...frozen };
    },
    readFile: async (...args) => {
      counts.fullReads += 1;
      return readFile(...args);
    },
    open: async (...args) => {
      const handle = await open(...args);
      return {
        read: async (...readArgs) => {
          counts.rangeReads += 1;
          const result = await handle.read(...readArgs);
          counts.rangeBytes += result.bytesRead;
          return result;
        },
        close: () => handle.close(),
      };
    },
  };
  const parse = (text) => {
    counts.parses += 1;
    return JSON.parse(text);
  };
  return { counts, options: { fs, parse } };
}

test("0 / 1 / 100 / 101 / 2000 records, default limit, ids and legacy projection", async (t) => {
  for (const count of [0, 1, 100, 101, 2000]) {
    await t.test(`${count} records`, async (t) => {
      const { file } = await fixture(t);
      const records = range(count).map((index) => entry(index, BASE_AT));
      await writeFile(file, jsonl(records));
      const session = { id: `session-size-${count}` };
      const store = newStore();

      const snapshot = await store.read(session, file);
      assert.equal(snapshot.records.length, count);
      assert.equal(snapshot.lineCount, count);
      assert.equal(snapshot.pendingBytes, 0);
      assert.equal(snapshot.byteSize, Buffer.byteLength(jsonl(records)));
      assert.equal(snapshot.filePath, file);
      assert.equal(snapshot.generation, 1);
      assert.equal("enabled" in snapshot, false);
      assert.equal(typeof snapshot.syncCursor, "string");
      assert.deepEqual(ids(snapshot.records), range(count));

      const legacy = store.legacyRecords(snapshot);
      assert.equal(legacy.length, count);
      assert.equal(legacy.every((record) => !("id" in record)), true);
      if (count > 0) {
        assert.deepEqual(legacy[0], {
          at: BASE_AT,
          sessionId: session.id,
          text: "record-0",
          toolName: "bash",
        });
      }

      const first = await store.page(session, file);
      assert.equal(first.records.length, Math.min(100, count));
      assert.deepEqual(ids(first.records), range(first.records.length, count - first.records.length).reverse());
      assert.equal(typeof first.syncCursor, "string");
      if (count <= 100) {
        assert.equal(first.nextCursor, null);
      } else {
        assert.equal(typeof first.nextCursor, "string");
        const second = await store.page(session, file, { before: first.nextCursor });
        assert.equal(second.records.length, Math.min(100, count - 100));
        assert.equal(second.records.some((record) => first.records.includes(record)), false);
      }

      if (count === 2000) {
        // Drain the entire display chain to catch duplicate/omitted lines.
        const seen = [...first.records];
        let cursor = first.nextCursor;
        while (cursor) {
          const page = await store.page(session, file, { before: cursor });
          seen.push(...page.records);
          cursor = page.nextCursor;
        }
        assert.equal(seen.length, 2000);
        assert.deepEqual(ids(seen), range(2000).reverse());
        assert.equal(new Set(ids(seen)).size, 2000);
      }
    });
  }
});

test("300 equal-at records use physical line as the total-order tie breaker", async (t) => {
  const { file } = await fixture(t);
  await writeFile(file, jsonl(range(300).map((index) => entry(index, BASE_AT))));
  const session = { id: "session-equal-at" };
  const store = newStore();

  const ascending = await store.read(session, file);
  assert.deepEqual(ids(ascending.records), range(300));
  const seen = [];
  let cursor = null;
  do {
    const page = await store.page(session, file, { limit: 77, before: cursor });
    seen.push(...page.records);
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(ids(seen), range(300).reverse());
});

test("out-of-order at values sort for display but after drains physical order", async (t) => {
  const { file } = await fixture(t);
  const session = { id: "session-out-of-order" };
  const store = newStore();
  await writeFile(file, "");
  const empty = await store.page(session, file);

  const records = [entry(0, at(20), "physical-first"), entry(1, at(10), "physical-second"), entry(2, at(15), "physical-third")];
  await writeFile(file, jsonl(records));
  const snapshot = await store.read(session, file);
  assert.deepEqual(texts(snapshot.records), ["physical-second", "physical-third", "physical-first"]);
  assert.deepEqual(ids(snapshot.records), [1, 2, 0]);

  const head = await store.page(session, file);
  assert.deepEqual(texts(head.records), ["physical-first", "physical-third", "physical-second"]);
  const drained = await store.page(session, file, { after: empty.syncCursor });
  assert.deepEqual(texts(drained.records), ["physical-first", "physical-second", "physical-third"]);
  assert.deepEqual(ids(drained.records), [0, 1, 2]);
});

test("a final line without LF stays pending for paging but the legacy projection still shows it", async (t) => {
  const { file } = await fixture(t);
  const session = { id: "session-unterminated" };
  const store = newStore();
  const first = `${JSON.stringify(entry(0, BASE_AT, "complete-0"))}\n`;
  const second = `${JSON.stringify(entry(1, at(1), "complete-1"))}`;
  await writeFile(file, first + second);

  // The paged path must not consume an unterminated line: more bytes can
  // still complete it.
  const snapshot = await store.read(session, file);
  assert.equal(snapshot.records.length, 1);
  assert.equal(snapshot.lineCount, 1);
  assert.equal(snapshot.pendingBytes, second.length);
  assert.equal(snapshot.pendingRecord.text, "complete-1");
  assert.equal(snapshot.pendingRecord.id, 1);

  const head = await store.page(session, file);
  assert.deepEqual(texts(head.records), ["complete-0"]);
  const drained = await store.page(session, file, { after: snapshot.syncCursor });
  assert.deepEqual(texts(drained.records), []);

  // The legacy reader parsed the whole file text, so its projection keeps the
  // unterminated line — and orders it exactly like the old stable `at` sort.
  const legacy = store.legacyRecords(snapshot);
  assert.deepEqual(legacy.map((record) => record.text), ["complete-0", "complete-1"]);
  assert.equal(legacy[1].id, undefined);
  assert.equal(legacy[1].sessionId, session.id);

  // Once the LF arrives the same physical line is a normal record, and the
  // legacy projection still shows it exactly once.
  await appendFile(file, "\n");
  const completed = await store.read(session, file);
  assert.equal(completed.records.length, 2);
  assert.equal(completed.pendingRecord, null);
  assert.deepEqual(ids(completed.records), [0, 1]);
  const legacyCompleted = store.legacyRecords(completed);
  assert.deepEqual(legacyCompleted.map((record) => record.text), ["complete-0", "complete-1"]);

  // An unterminated line with an OLD timestamp still sorts by (at, line).
  const backdated = `${JSON.stringify(entry(2, at(-1), "backdated"))}`;
  await writeFile(file, first + backdated);
  const backdatedSnapshot = await store.read(session, file);
  assert.equal(backdatedSnapshot.records.length, 1);
  const backdatedLegacy = store.legacyRecords(backdatedSnapshot);
  assert.deepEqual(backdatedLegacy.map((record) => record.text), ["backdated", "complete-0"]);
});

test("completely duplicate JSON lines remain separate records with separate ids", async (t) => {
  const { file } = await fixture(t);
  const duplicate = entry(1, BASE_AT, "same");
  await writeFile(file, jsonl([duplicate, duplicate, duplicate]));
  const store = newStore();
  const session = { id: "session-duplicates" };
  const snapshot = await store.read(session, file);
  assert.equal(snapshot.records.length, 3);
  assert.deepEqual(ids(snapshot.records), [0, 1, 2]);
  assert.deepEqual(texts(snapshot.records), ["same", "same", "same"]);
  const page = await store.page(session, file, { limit: 2 });
  assert.deepEqual(ids(page.records), [2, 1]);
  const older = await store.page(session, file, { before: page.nextCursor });
  assert.deepEqual(ids(older.records), [0]);
});

test("Unicode and a UTF-8 character split across appends stay byte-correct", async (t) => {
  const { file } = await fixture(t);
  const session = { id: "session-unicode-审计-😀" };
  const store = newStore();
  const first = Buffer.from(`${JSON.stringify(entry(0, BASE_AT, "中文 café 🚀"))}\n`, "utf8");
  const second = Buffer.from(`${JSON.stringify(entry(1, at(1), "emoji 😀 終わり"))}\n`, "utf8");
  const emoji = Buffer.from("😀", "utf8");
  const emojiAt = second.indexOf(emoji);
  assert.ok(emojiAt > 0);

  // End the first write in the middle of the four-byte emoji and without LF.
  const split = emojiAt + 2;
  await writeFile(file, Buffer.concat([first, second.subarray(0, split)]));
  let snapshot = await store.read(session, file);
  assert.equal(snapshot.records.length, 1);
  assert.equal(snapshot.lineCount, 1);
  assert.equal(snapshot.pendingBytes, split);
  assert.equal(snapshot.records[0].text, "中文 café 🚀");

  // Completing the character is still not enough: no LF means no record yet.
  await appendFile(file, second.subarray(split, second.length - 1));
  snapshot = await store.read(session, file);
  assert.equal(snapshot.records.length, 1);
  assert.equal(snapshot.lineCount, 1);
  assert.equal(snapshot.pendingBytes, second.length - 1);

  await appendFile(file, second.subarray(second.length - 1));
  snapshot = await store.read(session, file);
  assert.equal(snapshot.lineCount, 2);
  assert.equal(snapshot.pendingBytes, 0);
  assert.deepEqual(ids(snapshot.records), [0, 1]);
  assert.equal(snapshot.records[1].text, "emoji 😀 終わり");
  assert.equal(snapshot.records[1].sessionId, session.id);
});

test("bad, blank, and wrong-shape complete lines consume physical line numbers", async (t) => {
  const { file } = await fixture(t);
  const session = { id: "session-bad-lines" };
  const store = newStore();
  await writeFile(file, "");
  const empty = await store.page(session, file);
  const body = `${JSON.stringify(entry(0, BASE_AT, "good-0"))}\n` +
    "{not-json}\n" +
    "   \r\n" +
    `${JSON.stringify({ text: "missing-at" })}\n` +
    `${JSON.stringify(entry(4, at(4), "good-4"))}\n`;
  await writeFile(file, body);

  const snapshot = await store.read(session, file);
  assert.equal(snapshot.lineCount, 5);
  assert.deepEqual(ids(snapshot.records), [0, 4]);
  assert.deepEqual(texts(snapshot.records), ["good-0", "good-4"]);

  const first = await store.page(session, file, { after: empty.syncCursor, limit: 1 });
  assert.deepEqual(ids(first.records), [0]);
  assert.equal(decodeCursor(first.syncCursor).line, 1);
  assert.equal(typeof first.nextCursor, "string");
  const second = await store.page(session, file, { after: first.nextCursor, limit: 1 });
  // Lines 1..3 were consumed as bad lines; line 4 is the next emitted record.
  assert.deepEqual(ids(second.records), [4]);
  assert.equal(decodeCursor(second.syncCursor).line, 5);
  assert.equal(second.nextCursor, null);
});

test("growth reads only appended bytes; shrink and same-size rewrite rebuild with new generation", async (t) => {
  const { file } = await fixture(t);
  const session = { id: "store-growth" };
  const io = countedIo();
  const store = newStore(io.options);
  const initial = jsonl([entry(0), entry(1)]);
  await writeFile(file, initial);
  const cold = await store.read(session, file);
  assert.equal(io.counts.fullReads, 1);
  assert.equal(io.counts.parses, 2);
  const generation = cold.generation;

  const addition = jsonl([entry(2)]);
  await appendFile(file, addition);
  const grown = await store.read(session, file);
  assert.equal(grown.generation, generation);
  assert.deepEqual(ids(grown.records), [0, 1, 2]);
  assert.equal(io.counts.fullReads, 1);
  // The appended bytes plus the re-read head and tail windows that prove the
  // append (the head proves the file was not rewritten in place).
  assert.equal(io.counts.rangeBytes, Buffer.byteLength(addition) + Math.min(Buffer.byteLength(initial), 512) * 2);
  assert.equal(io.counts.parses, 3);

  await writeFile(file, jsonl([entry(0, BASE_AT, "A")]));
  const shrunk = await store.read(session, file);
  assert.equal(shrunk.generation, generation + 1);
  assert.deepEqual(ids(shrunk.records), [0]);
  assert.equal(io.counts.fullReads, 2);
  await expectCode(store.page(session, file, { after: grown.syncCursor }), "cursor-stale");

  // Same byte length but different content is a non-append rewrite.
  await writeFile(file, jsonl([entry(0, BASE_AT, "B")]));
  await utimes(file, new Date(), new Date(Date.now() + 5000));
  const rewritten = await store.read(session, file);
  assert.equal(rewritten.generation, shrunk.generation + 1);
  assert.equal(rewritten.records[0].text, "B");
  assert.equal(io.counts.fullReads, 3);
  await expectCode(store.page(session, file, { after: shrunk.syncCursor }), "cursor-stale");
});

test("path changes rebuild, invalidate cold-reads, and missing files are empty snapshots", async (t) => {
  const { directory, file } = await fixture(t);
  const other = join(directory, "other.jsonl");
  const session = { id: "session-paths" };
  const store = newStore();

  const missing = await store.read(session, file);
  assert.deepEqual(missing.records, []);
  assert.equal(missing.lineCount, 0);
  assert.equal(typeof missing.syncCursor, "string");
  await writeFile(file, jsonl([entry(0, BASE_AT, "first-file")]));
  const first = await store.read(session, file);
  assert.equal(first.records[0].text, "first-file");

  await writeFile(other, jsonl([entry(0, at(9), "other-file")]));
  const changed = await store.read(session, other);
  assert.equal(changed.generation, first.generation + 1);
  assert.equal(changed.filePath, other);
  assert.equal(changed.records[0].text, "other-file");
  await expectCode(store.page(session, other, { after: first.syncCursor }), "cursor-stale");

  store.invalidate(session);
  const invalidated = await store.read(session, other);
  assert.equal(invalidated.generation, changed.generation + 1);
  await expectCode(store.page(session, other, { after: changed.syncCursor }), "cursor-stale");

  await rm(file);
  const deleted = await store.read(session, file);
  // The path switch from other.jsonl also rebuilds, even if the target is absent.
  assert.equal(deleted.records.length, 0);
  assert.equal(deleted.generation, invalidated.generation + 1);
});

test("a new store after restart cold-reads once and preserves physical ids", async (t) => {
  const { file } = await fixture(t);
  const session = { id: "session-restart" };
  const io = countedIo();
  const records = [entry(0, at(2)), entry(1, at(1)), entry(2, at(3))];
  await writeFile(file, jsonl(records));

  const beforeRestart = newStore(io.options);
  const original = await beforeRestart.read(session, file);
  const afterRestart = newStore(io.options);
  const restored = await afterRestart.read(session, file);
  assert.deepEqual(restored.records, original.records);
  assert.equal(io.counts.fullReads, 2);
  assert.equal(io.counts.parses, 6);

  await afterRestart.read(session, file);
  await afterRestart.page(session, file);
  assert.equal(io.counts.fullReads, 2);
  assert.equal(io.counts.parses, 6);
});

test("bad, wrong-session, wrong-kind, future and stale cursors plus bad limits are rejected", async (t) => {
  const { file } = await fixture(t);
  const session = { id: "session-cursor-owner" };
  const otherSession = { id: "session-cursor-other" };
  const store = newStore();
  await writeFile(file, jsonl(range(4).map((index) => entry(index))));
  const snapshot = await store.read(session, file);
  const head = await store.page(session, file, { limit: 2 });

  for (const bad of ["", "%%%", "a", Buffer.from("not json").toString("base64url"), Buffer.from("{}").toString("base64url")]) {
    await expectCode(store.page(session, file, { before: bad }), "invalid-cursor");
  }
  await expectCode(store.page(otherSession, file, { before: head.nextCursor }), "invalid-cursor");
  await expectCode(store.page(session, file, { after: head.nextCursor }), "invalid-cursor");
  await expectCode(store.page(session, file, { before: snapshot.syncCursor }), "invalid-cursor");
  await expectCode(store.page(session, file, { before: head.nextCursor, after: snapshot.syncCursor }), "invalid-cursor");

  const future = Buffer.from(JSON.stringify({
    v: 1,
    sid: session.id,
    g: snapshot.generation,
    k: "after",
    line: 99,
  })).toString("base64url");
  await expectCode(store.page(session, file, { after: future }), "invalid-cursor");
  for (const limit of [0, -1, 201, 1.5, "100", null]) {
    await expectCode(store.page(session, file, { limit }), "invalid-limit");
  }

  await writeFile(file, jsonl([entry(0, BASE_AT, "rewritten")]));
  await expectCode(store.page(session, file, { before: head.nextCursor }), "cursor-stale");
  await expectCode(store.page(session, file, { after: snapshot.syncCursor }), "cursor-stale");
});

test("before fixes the original head so appends never drift an old page chain", async (t) => {
  const { file } = await fixture(t);
  const session = { id: "session-fixed-head" };
  const store = newStore();
  await writeFile(file, jsonl(range(5).map((index) => entry(index, at(index)))));

  const first = await store.page(session, file, { limit: 2 });
  assert.deepEqual(ids(first.records), [4, 3]);
  assert.equal(decodeCursor(first.syncCursor).line, 5);

  // One very old and one very new timestamp: neither may enter the old chain.
  await appendFile(file, jsonl([
    entry(5, at(-10), "appended-old"),
    entry(6, at(100), "appended-new"),
  ]));
  const second = await store.page(session, file, { before: first.nextCursor, limit: 2 });
  assert.deepEqual(ids(second.records), [2, 1]);
  assert.equal(second.syncCursor, first.syncCursor);
  const third = await store.page(session, file, { before: second.nextCursor, limit: 2 });
  assert.deepEqual(ids(third.records), [0]);
  assert.equal(third.nextCursor, null);

  const tail = await store.page(session, file, { after: first.syncCursor });
  assert.deepEqual(ids(tail.records), [5, 6]);
  assert.deepEqual(texts(tail.records), ["appended-old", "appended-new"]);
});

test("after drains 250 out-of-order records in 100/100/50 pages exactly once", async (t) => {
  const { file } = await fixture(t);
  const session = { id: "session-after-250" };
  const store = newStore();
  await writeFile(file, "");
  const empty = await store.page(session, file);
  const records = range(250).map((index) => entry(index, at(1000 - index), `physical-${index}`));
  await writeFile(file, jsonl(records));

  const pages = [];
  let cursor = empty.syncCursor;
  for (;;) {
    const page = await store.page(session, file, { after: cursor, limit: 100 });
    pages.push(page);
    assert.equal(typeof page.syncCursor, "string");
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  assert.deepEqual(pages.map((page) => page.records.length), [100, 100, 50]);
  assert.deepEqual(pages.map((page) => decodeCursor(page.syncCursor).line), [100, 200, 250]);
  const seen = pages.flatMap((page) => page.records);
  assert.deepEqual(ids(seen), range(250));
  assert.deepEqual(texts(seen), range(250).map((index) => `physical-${index}`));
  assert.equal(new Set(ids(seen)).size, 250);

  await appendFile(file, jsonl([
    entry(250, at(-100), "new-old-at"),
    entry(251, at(-200), "new-older-at"),
  ]));
  const tail = await store.page(session, file, { after: pages[2].syncCursor, limit: 100 });
  assert.deepEqual(ids(tail.records), [250, 251]);
  assert.deepEqual(texts(tail.records), ["new-old-at", "new-older-at"]);
  assert.equal(tail.nextCursor, null);
});

test("a missing audit file stays readable and pageable on every call", async (t) => {
  const { file } = await fixture(t);
  const session = { id: "session-missing" };
  const store = newStore();
  // The sidecar does not exist yet — that is the normal state of a session
  // that has not produced an approval record.
  for (let round = 0; round < 3; round += 1) {
    const snapshot = await store.read(session, file);
    assert.equal(snapshot.records.length, 0);
    assert.equal(snapshot.generation, 1);
    const page = await store.page(session, file);
    assert.deepEqual(page.records, []);
    assert.equal(page.nextCursor, null);
    assert.equal(typeof page.syncCursor, "string");
  }
  // The file appears later: the index must pick it up.
  await writeFile(file, jsonl([entry(0, BASE_AT, "late")]));
  const after = await store.read(session, file);
  assert.deepEqual(texts(after.records), ["late"]);
});

test("the legacy fallback still yields the readable prefix of an unstable file", async (t) => {
  const { file } = await fixture(t);
  const session = { id: "session-unstable" };
  const store = newStore();
  await writeFile(file, jsonl([entry(0, BASE_AT, "A"), entry(1, BASE_AT, "B")]));
  const fallback = await store.legacyFallback(session, file);
  assert.deepEqual(fallback.map((record) => record.text), ["A", "B"]);
  // A missing file yields nothing instead of throwing.
  const missing = await store.legacyFallback(session, file + ".nope");
  assert.deepEqual(missing, []);
});

test("a same-size in-place rewrite is detected even when the timestamp does not move", async (t) => {
  const { file } = await fixture(t);
  const session = { id: "session-same-size" };
  const io = frozenStatIo();
  const store = newStore(io.options);
  const first = jsonl([entry(0, BASE_AT, "A"), entry(1, BASE_AT, "B")]);
  const second = jsonl([entry(0, BASE_AT, "C"), entry(1, BASE_AT, "D")]);
  assert.equal(Buffer.byteLength(first), Buffer.byteLength(second), "the rewrite must keep the length");
  await writeFile(file, first);
  const before = await store.read(session, file);
  assert.deepEqual(texts(before.records), ["A", "B"]);

  // Same length, rewritten in place, and the stat keeps reporting exactly
  // the same values (dev/ino/size/mtime/ctime) — the store must notice
  // through the content, not through the timestamp.
  await writeFile(file, second);
  const after = await store.read(session, file);
  assert.deepEqual(texts(after.records), ["C", "D"], "the rewrite must not be served from the stale snapshot");
  assert.deepEqual(ids(after.records), [0, 1]);
  assert.ok(after.generation > before.generation, "a rewrite must advance the generation");

  // The legacy projection sees the new content too.
  const legacy = store.legacyRecords(after);
  assert.deepEqual(legacy.map((record) => record.text), ["C", "D"]);
});

test("cold and hot polling counters prove unchanged stat does no full read and no parse", async (t) => {
  const { file } = await fixture(t);
  const session = { id: "session-hot-poll" };
  const io = countedIo();
  const store = newStore(io.options);
  const initial = jsonl(range(3).map((index) => entry(index)));
  await writeFile(file, initial);

  await store.read(session, file);
  assert.equal(io.counts.fullReads, 1);
  assert.equal(io.counts.parses, 3);
  assert.equal(io.counts.rangeBytes, 0);

  // Hot polling re-reads a bounded window (first + last 512 bytes) so a
  // same-size in-place rewrite cannot hide behind an unchanged timestamp.
  // It never re-reads the whole file and never parses.
  const window = Math.min(Buffer.byteLength(initial), 512);
  for (let index = 0; index < 5; index += 1) {
    await Promise.all([
      store.read(session, file),
      store.page(session, file),
      store.page(session, file, { limit: 1 }),
    ]);
  }
  assert.equal(io.counts.fullReads, 1, "hot polling must not full-read");
  assert.equal(io.counts.parses, 3, "hot polling must not parse");
  assert.equal(io.counts.rangeReads, 30, "hot polling must only spot-check two windows per call");
  assert.equal(io.counts.rangeBytes, 30 * window);

  const appended = jsonl([entry(3)]);
  await appendFile(file, appended);
  await store.page(session, file);
  assert.equal(io.counts.fullReads, 1);
  assert.equal(io.counts.parses, 4);
  // The appended bytes plus the re-read head and tail windows that prove the
  // append (the head proves the file was not rewritten in place).
  assert.equal(io.counts.rangeBytes, 30 * window + Buffer.byteLength(appended) + window + window);
});

test("a file rewritten in place and grown is rebuilt, not mistaken for an append", async (t) => {
  const { file } = await fixture(t);
  const session = { id: "session-rewritten" };
  const store = newStore();
  const original = jsonl([entry(0), entry(1), entry(2)]);
  await writeFile(file, original);
  const before = await store.read(session, file);
  assert.equal(before.records.length, 3);

  // Same inode, larger size, different content: an append-only reader would
  // splice the new tail onto the old records and corrupt the trail.
  const rewritten = jsonl([entry(0, BASE_AT, "rewritten-0"), entry(1), entry(2), entry(3), entry(4)]);
  await writeFile(file, rewritten);
  const after = await store.read(session, file);
  assert.equal(after.records.length, 5);
  assert.deepEqual(texts(after.records), ["rewritten-0", "record-1", "record-2", "record-3", "record-4"]);
  assert.deepEqual(ids(after.records), [0, 1, 2, 3, 4]);
  assert.ok(after.generation > before.generation, "a rewrite must advance the generation");
});

test("concurrent reads/pages share one cold read and concurrent half-line appends settle cleanly", async (t) => {
  const { file } = await fixture(t);
  const session = { id: "session-concurrency" };
  const io = countedIo();
  const store = newStore(io.options);
  await writeFile(file, jsonl(range(20).map((index) => entry(index))));

  await Promise.all(range(30).map((index) => index % 2 === 0
    ? store.read(session, file)
    : store.page(session, file, { limit: 10 })));
  assert.equal(io.counts.fullReads, 1);
  assert.equal(io.counts.parses, 20);

  const next = Buffer.from(jsonl([entry(20, BASE_AT, "concurrent-😀")]), "utf8");
  await appendFile(file, next.subarray(0, 17));
  const readers = range(12).map(() => store.read(session, file));
  const writer = appendFile(file, next.subarray(17));
  await Promise.all([...readers, writer]);
  const settled = await store.read(session, file);
  assert.equal(settled.records.length, 21);
  assert.equal(settled.records.find((record) => record.id === 20).text, "concurrent-😀");
  assert.equal(settled.lineCount, 21);
  assert.equal(settled.pendingBytes, 0);
});
