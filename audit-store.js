import { open as defaultOpen, readFile as defaultReadFile, stat as defaultStat } from "node:fs/promises";

/**
 * Per-session, lazy, append-only JSONL audit index.
 *
 * API
 * ---
 *   const store = new AuditRecordStore(shapeRecord, options?)
 *   await store.read(session, filePath)
 *     -> { filePath, generation, lineCount, byteSize, pendingBytes,
 *          records, syncCursor }
 *   await store.page(session, filePath, { limit?, before?, after? })
 *     -> { records, nextCursor, syncCursor }
 *   store.legacyRecords(snapshot)
 *     -> the old wire shape: records in ascending (at, line), with no id.
 *   store.invalidate(session)
 *
 * `session` is a WeakMap key and must have a non-empty `id`. `shapeRecord` is
 * synchronous and receives `(session.id, parsedJson)` for every complete JSON
 * line whose parsed value is an object with a string `at`. It returns the
 * existing plain audit record. The store emits `{ ...shape, id }`; `id` is the
 * zero-based physical line number. Bad and blank complete lines consume a line
 * number but emit no record. A final line without LF is retained as a partial
 * line and is not parsed until its LF arrives.
 *
 * `read()` returns display-ordered records (ascending `at`, then physical
 * line), matching the old stable `at` sort. Its metadata deliberately contains
 * no `enabled` field. `legacyRecords(readResult)` strips `id` and preserves the
 * old array shape. Returned record objects are frozen; arrays/snapshots are
 * fresh projections and may be changed by the caller.
 *
 * `read()` also reports `pendingRecord`: the final physical line when it has
 * no LF yet but already parses as a valid record. The old reader showed such
 * a line, so `legacyRecords()` folds it in; the paged path never does, because
 * an unterminated line can still grow and must not be consumed.
 *
 * Pagination
 * ----------
 * The default limit is 100; valid limits are integers in [1, 200]. `before`
 * and `after` are mutually exclusive opaque base64url cursors. Both cursor
 * kinds carry `v`, `sid`, and `generation`; malformed cursors, cursor kinds,
 * and session mismatches throw `code = "invalid-cursor"`. A generation
 * mismatch throws `code = "cursor-stale"`. Invalid limits throw
 * `code = "invalid-limit"`.
 *
 * With no cursor, page() returns the newest head page in descending
 * (at, line). `before` continues towards older records. Its cursor fixes the
 * original head's physical line high-water mark, so later appends never enter
 * or shift that pagination chain. `nextCursor` is null when no older records
 * remain in that fixed head.
 *
 * `after` drains complete physical lines in ascending line order, regardless
 * of `at`. Its cursor names the next unconsumed line. If more physical lines
 * remain after the returned page, `nextCursor` continues the drain; otherwise
 * it is null. `syncCursor` is always a string for every page (including an
 * empty one), advances only through complete lines actually consumed by that
 * call, and can be used as the next `after` token. On head/before pages it
 * points at the fixed head, not at later appends.
 *
 * Storage and concurrency
 * -----------------------
 * Each Session has a lazy WeakMap entry and a promise queue. Concurrent
 * read/page calls for one Session therefore cannot race path changes or issue
 * duplicate cold reads. The first existing file is read once. An unchanged
 * stat performs no file read and no JSON parse; growth reads only the new byte
 * range plus a fixed tail window that proves the file grew by an append rather
 * than being rewritten in place. Parsing is byte/LF based, so UTF-8 characters
 * split across append writes are safe. Path changes, deletion, shrinkage,
 * inode replacement, and same-size/non-append stat changes force a rebuild and
 * increment generation. Ordinary appends retain generation and existing
 * cursors.
 *
 * `invalidate(session)` synchronously drops the cached snapshot and advances
 * generation. The next queued read/page cold-reads the file; older cursors are
 * stale. In-flight reads detect invalidation and retry against the new epoch.
 *
 * The optional second constructor argument is for deterministic tests and
 * embedders: `{ fs: { stat, readFile, open }, parse }`. The fs methods mirror
 * node:fs/promises; `open` must return a handle with read/close. `parse`
 * defaults to JSON.parse. No approval-flow methods are called by this module.
 */
/**
 * How many trailing bytes are re-read on growth to prove that the file really
 * grew by an append. A rewritten file that keeps this tail byte-identical is
 * the only case the check cannot see.
 */
const TAIL_WINDOW = 512;

/** Display order: timestamp first, physical line as the stable tie breaker. */
function compareAuditOrder(left, right) {
  if (left.at < right.at) return -1;
  if (left.at > right.at) return 1;
  return left.id - right.id;
}

export class AuditRecordStore {
  constructor(shapeRecord, options = {}) {
    if (typeof shapeRecord !== "function") {
      throw new TypeError("shapeRecord must be a function");
    }
    const fs = options && options.fs ? options.fs : {};
    this._shapeRecord = shapeRecord;
    this._stat = typeof fs.stat === "function" ? fs.stat : defaultStat;
    this._readFile = typeof fs.readFile === "function" ? fs.readFile : defaultReadFile;
    this._open = typeof fs.open === "function" ? fs.open : defaultOpen;
    this._parse = typeof (options && options.parse) === "function" ? options.parse : JSON.parse;
    this._states = new WeakMap();
  }

  /** Return the current display-ordered snapshot for one session. */
  async read(session, filePath) {
    const state = this._state(session);
    this._assertPath(filePath);
    return this._enqueue(state, async () => {
      const snapshot = await this._sync(state, filePath);
      return this._publicSnapshot(session.id, snapshot);
    });
  }

  /** Return one cursor page for one session. */
  async page(session, filePath, options = {}) {
    const state = this._state(session);
    this._assertPath(filePath);
    const opts = options && typeof options === "object" ? options : {};
    const limit = opts.limit === undefined ? 100 : opts.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw this._error("invalid-limit", "limit must be an integer from 1 to 200");
    }
    const hasBefore = opts.before !== undefined && opts.before !== null;
    const hasAfter = opts.after !== undefined && opts.after !== null;
    if (hasBefore && hasAfter) {
      throw this._error("invalid-cursor", "before and after are mutually exclusive");
    }
    const sid = String(session.id);
    const before = hasBefore ? this._decodeCursor(opts.before, sid, "before") : null;
    const after = hasAfter ? this._decodeCursor(opts.after, sid, "after") : null;

    return this._enqueue(state, async () => {
      const snapshot = await this._sync(state, filePath);
      if (before) this._assertGeneration(before, snapshot);
      if (after) this._assertGeneration(after, snapshot);
      if (after) return this._afterPage(sid, snapshot, after, limit);
      return this._beforePage(sid, snapshot, before, limit);
    });
  }

  /**
   * Project a read() snapshot to the legacy sessionRecords array: ascending
   * (at, line), no physical id, and no other shape changes.
   *
   * The old reader parsed the whole file text, so a final line that had no LF
   * still appeared. The legacy projection keeps that behavior by folding in
   * `pendingRecord`; the paged path never does.
   */
  legacyRecords(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.records)) return [];
    const records = snapshot.records.slice();
    const pending = snapshot.pendingRecord;
    if (pending !== null && pending !== undefined) {
      let index = records.length;
      while (index > 0 && compareAuditOrder(pending, records[index - 1]) < 0) index -= 1;
      records.splice(index, 0, pending);
    }
    return records.map((record) => {
      const legacy = { ...record };
      delete legacy.id;
      return legacy;
    });
  }

  /**
   * Best-effort legacy read, used only when the incremental index cannot be
   * trusted (for example the file kept changing while it was being read).
   * It performs exactly one plain read, like the pre-1.12 reader, and returns
   * the records that were readable — never a hard failure. The legacy
   * contract promised "whatever a single readFile sees", so a partially
   * written file must still yield its readable prefix.
   */
  async legacyFallback(session, filePath) {
    let text;
    try {
      text = await this._readFile(filePath, "utf8");
    } catch (error) {
      return [];
    }
    const sessionId = session && session.id ? String(session.id) : "";
    const records = [];
    const lines = typeof text === "string" ? text.split("\n") : [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (line === "") continue;
      try {
        const parsed = this._parse(line);
        if (parsed && typeof parsed === "object" && typeof parsed.at === "string") {
          records.push({ at: parsed.at, line: index, record: this._shapeRecord(sessionId, parsed) });
        }
      } catch (error) {
        /* skip the corrupt line */
      }
    }
    records.sort((left, right) => compareAuditOrder(left, right));
    return records.map((entry) => entry.record);
  }

  /** Drop one session's snapshot without retaining a strong Session reference. */
  invalidate(session) {
    const state = this._state(session);
    state.snapshot = null;
    state.generation = Math.max(1, state.generation + 1);
    state.epoch += 1;
  }

  _state(session) {
    const kind = typeof session;
    if (session === null || (kind !== "object" && kind !== "function")) {
      throw this._error("invalid-session", "session must be a WeakMap-compatible object");
    }
    if (typeof session.id !== "string" && typeof session.id !== "number") {
      throw this._error("invalid-session", "session.id is required");
    }
    if (String(session.id) === "") {
      throw this._error("invalid-session", "session.id is required");
    }
    let state = this._states.get(session);
    if (!state) {
      state = {
        sid: String(session.id),
        snapshot: null,
        generation: 0,
        epoch: 0,
        tail: Promise.resolve(),
      };
      this._states.set(session, state);
    }
    return state;
  }

  _enqueue(state, operation) {
    const result = state.tail.then(operation);
    state.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  _assertPath(filePath) {
    if (typeof filePath !== "string" || filePath === "") {
      throw this._error("invalid-path", "filePath must be a non-empty string");
    }
  }

  _error(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  async _statFile(filePath) {
    try {
      const value = await this._stat(filePath);
      return {
        dev: Number(value.dev),
        ino: Number(value.ino),
        size: Number(value.size),
        mtimeMs: Number(value.mtimeMs),
        ctimeMs: Number(value.ctimeMs),
      };
    } catch (error) {
      if (error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return null;
      throw error;
    }
  }

  _sameStat(left, right) {
    if (left === null || right === null) return left === right;
    return left.dev === right.dev &&
      left.ino === right.ino &&
      left.size === right.size &&
      left.mtimeMs === right.mtimeMs &&
      left.ctimeMs === right.ctimeMs;
  }

  _sameFile(left, right) {
    return left !== null && right !== null && left.dev === right.dev && left.ino === right.ino;
  }

  /**
   * Prove that the file still starts and ends with the bytes this snapshot
   * was built from. A rewrite that keeps both windows byte-identical is the
   * one case this cannot see; everything else is caught without re-reading
   * the whole file.
   */
  async _verifyUnchanged(base, filePath) {
    // No file yet (the common case for a session without approvals): there is
    // nothing to compare, and the empty snapshot is still correct.
    if (base.stat === null) return true;
    const size = base.stat.size;
    if (size === 0) return true;
    const windowLength = Math.min(size, TAIL_WINDOW);
    try {
      const head = await this._readRange(filePath, 0, windowLength);
      const tail = await this._readRange(filePath, size - windowLength, size);
      if (head.length !== windowLength || tail.length !== windowLength) return false;
      if (!head.equals(base.head)) return false;
      if (!tail.equals(base.tail)) return false;
      return true;
    } catch (error) {
      if (error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return false;
      throw error;
    }
  }

  async _sync(state, filePath) {
    for (;;) {
      const epoch = state.epoch;
      const base = state.snapshot;
      const next = await this._syncFrom(base, state.generation, filePath, state.sid);
      if (epoch !== state.epoch) continue;
      state.snapshot = next;
      state.generation = next.generation;
      return next;
    }
  }

  async _syncFrom(base, currentGeneration, filePath, sessionId) {
    if (!base) {
      return this._loadFull(filePath, Math.max(1, currentGeneration), sessionId);
    }
    if (base.filePath !== filePath) {
      return this._loadFull(filePath, base.generation + 1, sessionId);
    }

    const observed = await this._statFile(filePath);
    if (this._sameStat(base.stat, observed)) {
      // The stat is unchanged — but on Windows/NTFS the timestamp of a
      // rewritten file can be identical to the previous one (measured: 135 of
      // 200 rapid in-place rewrites reported the very same mtimeMs), so a
      // same-size rewrite would be invisible here and the store would keep
      // serving records that no longer exist on disk. Spot-check the first
      // and the last window instead of trusting the timestamp: O(1) I/O, no
      // parse, no sort.
      const intact = await this._verifyUnchanged(base, filePath);
      if (intact) return base;
      return this._loadFull(filePath, base.generation + 1, sessionId);
    }

    const mustRebuild = observed === null || base.stat === null ||
      !this._sameFile(base.stat, observed) || observed.size <= base.stat.size;
    if (mustRebuild) {
      return this._loadFull(filePath, base.generation + 1, sessionId);
    }

    // Growth: read the new byte range plus the known tail window, and prove
    // the tail is unchanged. A file that was rewritten in place (same inode,
    // larger) would otherwise be mistaken for an append and would silently
    // corrupt the audit trail.
    const tailLength = Math.min(base.stat.size, TAIL_WINDOW);
    const readStart = base.stat.size - tailLength;
    let window;
    try {
      window = await this._readRange(filePath, readStart, observed.size);
    } catch (error) {
      if (error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
        return this._loadFull(filePath, base.generation + 1, sessionId);
      }
      throw error;
    }
    if (tailLength > 0 && !window.subarray(0, tailLength).equals(base.tail)) {
      return this._loadFull(filePath, base.generation + 1, sessionId);
    }
    // The head window must be intact as well: a file that was rewritten in
    // place (and happened to grow, with an unchanged timestamp) would
    // otherwise be spliced onto stale records.
    const headLength = Math.min(base.stat.size, TAIL_WINDOW);
    if (headLength > 0) {
      let head;
      try {
        head = await this._readRange(filePath, 0, headLength);
      } catch (error) {
        if (error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
          return this._loadFull(filePath, base.generation + 1, sessionId);
        }
        throw error;
      }
      if (!head.equals(base.head)) {
        return this._loadFull(filePath, base.generation + 1, sessionId);
      }
    }
    const appended = window.subarray(tailLength);
    if (appended.length !== observed.size - base.stat.size) {
      return this._loadFull(filePath, base.generation + 1, sessionId);
    }

    const after = await this._statFile(filePath);
    const disappeared = after === null || !this._sameFile(observed, after) || after.size < observed.size;
    const changedWithoutGrowth = after !== null && after.size === observed.size &&
      !this._sameStat(observed, after);
    if (disappeared || changedWithoutGrowth) {
      return this._loadFull(filePath, base.generation + 1, sessionId);
    }

    // If still more bytes arrived, publish the stable observed prefix now;
    // the next poll consumes the remainder as another append.
    return this._appendSnapshot(base, observed, appended, sessionId);
  }

  async _loadFull(filePath, generation, sessionId) {
    // A writer can append between stat/read/stat. Retry so the cached stat
    // always describes exactly the bytes represented by the snapshot.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const before = await this._statFile(filePath);
      if (before === null) {
        return this._makeSnapshot(filePath, generation, null, [], 0, Buffer.alloc(0), 0, sessionId);
      }
      let bytes;
      try {
        const value = await this._readFile(filePath);
        bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
      } catch (error) {
        if (error && (error.code === "ENOENT" || error.code === "ENOTDIR")) continue;
        throw error;
      }
      const after = await this._statFile(filePath);
      if (after !== null && this._sameStat(before, after) && bytes.length === before.size) {
        return this._snapshotFromBytes(filePath, generation, before, bytes, sessionId);
      }
    }
    throw this._error("audit-store-unstable", "audit file kept changing during a cold read");
  }

  async _readRange(filePath, start, end) {
    const handle = await this._open(filePath, "r");
    try {
      const wanted = end - start;
      const bytes = Buffer.allocUnsafe(wanted);
      let offset = 0;
      while (offset < wanted) {
        const result = await handle.read(bytes, offset, wanted - offset, start + offset);
        const count = typeof result === "number" ? result : result.bytesRead;
        if (!count) break;
        offset += count;
      }
      return bytes.subarray(0, offset);
    } finally {
      await handle.close();
    }
  }

  _snapshotFromBytes(filePath, generation, stat, bytes, sessionId) {
    const physical = [];
    let lineCount = 0;
    let start = 0;
    for (let index = 0; index < bytes.length; index += 1) {
      if (bytes[index] !== 0x0a) continue;
      const record = this._recordFromLine(bytes.subarray(start, index), lineCount, sessionId);
      if (record) physical.push(record);
      lineCount += 1;
      start = index + 1;
    }
    const pending = Buffer.from(bytes.subarray(start));
    return this._makeSnapshot(
      filePath,
      generation,
      stat,
      physical,
      lineCount,
      pending,
      bytes.length,
      sessionId,
      bytes.subarray(Math.max(0, bytes.length - TAIL_WINDOW)),
      bytes.subarray(0, Math.min(bytes.length, TAIL_WINDOW)),
    );
  }

  _appendSnapshot(base, stat, appended, sessionId) {
    const bytes = base.pending.length === 0 ? appended : Buffer.concat([base.pending, appended]);
    const physical = base.physical.slice();
    let lineCount = base.lineCount;
    let start = 0;
    for (let index = 0; index < bytes.length; index += 1) {
      if (bytes[index] !== 0x0a) continue;
      const record = this._recordFromLine(bytes.subarray(start, index), lineCount, sessionId);
      if (record) physical.push(record);
      lineCount += 1;
      start = index + 1;
    }
    const pending = Buffer.from(bytes.subarray(start));
    const combined = Buffer.concat([base.tail, appended]);
    const combinedHead = Buffer.concat([base.head, appended]);
    return this._makeSnapshot(
      base.filePath,
      base.generation,
      stat,
      physical,
      lineCount,
      pending,
      stat.size,
      sessionId,
      combined.subarray(Math.max(0, combined.length - TAIL_WINDOW)),
      combinedHead.subarray(0, Math.min(combinedHead.length, TAIL_WINDOW)),
    );
  }

  _recordFromLine(bytes, line, sessionId) {
    const text = bytes.toString("utf8").trim();
    if (text === "") return null;
    try {
      const parsed = this._parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof parsed.at !== "string") {
        return null;
      }
      const shape = this._shapeRecord(sessionId, parsed);
      if (!shape || typeof shape !== "object" || Array.isArray(shape) || typeof shape.at !== "string") {
        return null;
      }
      const record = Object.freeze({ ...shape, id: line });
      return Object.freeze({ line, at: record.at, record });
    } catch (error) {
      // JSON and shape failures make this a bad complete line. Its physical
      // line number is still consumed by the caller.
      return null;
    }
  }

  _makeSnapshot(filePath, generation, stat, physical, lineCount, pending, byteSize, sessionId, tail, head) {
    const sorted = physical.slice().sort((left, right) => {
      if (left.at < right.at) return -1;
      if (left.at > right.at) return 1;
      return left.line - right.line;
    });
    return {
      filePath,
      generation,
      stat,
      physical,
      sorted,
      lineCount,
      pending,
      // The first and last bytes of the file, used to prove that a file whose
      // timestamp did not move was not rewritten in place.
      head: head === undefined ? Buffer.alloc(0) : head,
      tail: tail === undefined ? Buffer.alloc(0) : tail,
      // A final line without its LF is still a physical line: the legacy
      // reader parsed it, so the legacy projection must show it too. It stays
      // OUT of `physical`/`sorted` because the paged path may not consume an
      // unterminated line — more bytes can still complete it.
      pendingRecord: pending.length > 0 ? this._recordFromLine(pending, lineCount, sessionId) : null,
      byteSize,
    };
  }

  _publicSnapshot(sessionId, snapshot) {
    return {
      filePath: snapshot.filePath,
      generation: snapshot.generation,
      lineCount: snapshot.lineCount,
      byteSize: snapshot.byteSize,
      pendingBytes: snapshot.pending.length,
      records: snapshot.sorted.map((entry) => entry.record),
      // A final line whose LF is missing is still a physical line the legacy
      // reader parsed. The paged path never consumes it (an unterminated line
      // can still grow); the legacy projection below keeps showing it.
      pendingRecord: snapshot.pendingRecord ? snapshot.pendingRecord.record : null,
      syncCursor: this._encodeCursor({
        v: 1,
        sid: String(sessionId),
        g: snapshot.generation,
        k: "after",
        line: snapshot.lineCount,
      }),
    };
  }

  _beforePage(sid, snapshot, cursor, limit) {
    const head = cursor ? cursor.head : snapshot.lineCount;
    if (cursor && (head < 1 || head > snapshot.lineCount)) {
      throw this._error("invalid-cursor", "before cursor head is outside the snapshot");
    }
    if (cursor && (cursor.line < 0 || cursor.line >= head)) {
      throw this._error("invalid-cursor", "before cursor line is outside its head");
    }

    const eligible = [];
    for (let index = snapshot.sorted.length - 1; index >= 0; index -= 1) {
      const entry = snapshot.sorted[index];
      if (entry.line >= head) continue;
      if (cursor) {
        const newerThanAnchor = entry.at > cursor.at ||
          (entry.at === cursor.at && entry.line >= cursor.line);
        if (newerThanAnchor) continue;
      }
      eligible.push(entry);
    }

    const selected = eligible.slice(0, limit);
    let nextCursor = null;
    if (eligible.length > limit && selected.length > 0) {
      const last = selected[selected.length - 1];
      nextCursor = this._encodeCursor({
        v: 1,
        sid,
        g: snapshot.generation,
        k: "before",
        head,
        at: last.at,
        line: last.line,
      });
    }
    return {
      records: selected.map((entry) => entry.record),
      nextCursor,
      syncCursor: this._encodeCursor({
        v: 1,
        sid,
        g: snapshot.generation,
        k: "after",
        line: head,
      }),
    };
  }

  _afterPage(sid, snapshot, cursor, limit) {
    const start = cursor.line;
    if (start > snapshot.lineCount) {
      throw this._error("invalid-cursor", "after cursor is beyond the consumed file");
    }
    const records = [];
    let position = start;
    let index = this._lowerBoundLine(snapshot.physical, start);
    while (index < snapshot.physical.length && records.length < limit) {
      const entry = snapshot.physical[index];
      records.push(entry.record);
      position = entry.line + 1;
      index += 1;
    }
    // Fewer than limit valid records means every remaining complete physical
    // line (including bad lines) was consumed by this call.
    if (records.length < limit) position = snapshot.lineCount;
    const nextCursor = position < snapshot.lineCount
      ? this._encodeCursor({ v: 1, sid, g: snapshot.generation, k: "after", line: position })
      : null;
    return {
      records,
      nextCursor,
      syncCursor: this._encodeCursor({
        v: 1,
        sid,
        g: snapshot.generation,
        k: "after",
        line: position,
      }),
    };
  }

  _lowerBoundLine(entries, line) {
    let low = 0;
    let high = entries.length;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      if (entries[middle].line < line) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  _assertGeneration(cursor, snapshot) {
    if (cursor.g !== snapshot.generation) {
      throw this._error("cursor-stale", "cursor belongs to an older audit-file generation");
    }
  }

  _encodeCursor(payload) {
    return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  }

  _decodeCursor(text, sid, expectedKind) {
    const invalid = () => this._error("invalid-cursor", "invalid audit cursor");
    if (typeof text !== "string" || text.length === 0 || text.length > 8192 ||
      !/^[A-Za-z0-9_-]+$/.test(text) || text.length % 4 === 1) {
      throw invalid();
    }
    let cursor;
    try {
      const json = Buffer.from(text, "base64url").toString("utf8");
      cursor = JSON.parse(json);
    } catch (error) {
      throw invalid();
    }
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor) ||
      cursor.v !== 1 || cursor.sid !== sid || cursor.k !== expectedKind ||
      !Number.isSafeInteger(cursor.g) || cursor.g < 1) {
      throw invalid();
    }
    if (expectedKind === "after") {
      if (!Number.isSafeInteger(cursor.line) || cursor.line < 0) throw invalid();
      return cursor;
    }
    if (!Number.isSafeInteger(cursor.head) || cursor.head < 1 ||
      !Number.isSafeInteger(cursor.line) || cursor.line < 0 || typeof cursor.at !== "string") {
      throw invalid();
    }
    return cursor;
  }
}
