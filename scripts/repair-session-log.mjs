// Repair DSH session logs poisoned by the retired v1.5.0 audit storage:
// `agent-approval/record` events were appended via session.append() without the
// envelope `ignorable` marker, so dsh-session-persistence's load-time
// assertEventsSupported() refuses the whole log ("unknown to this harness and
// not marked ignorable").
//
// Fix: add `"ignorable":true` to those event envelopes — the documented
// compatibility mechanism for out-of-repo plugin events — without touching
// anything else. Deleting lines is NOT an option: the scanner enforces
// contiguous seqs. Only frames containing patched lines are re-compressed
// (checksummed, same options the harness writer uses); every other frame stays
// byte-identical.
//
// Usage:
//   node scripts/repair-session-log.mjs <session.jsonl.zstd> [--dry-run]
import { readFileSync, writeFileSync, copyFileSync, statSync, renameSync } from "node:fs";
import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { dirname, join } from "node:path";

const RECORD_EVENT = "agent-approval/record";
const CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };
const MAGIC = 0xfd2fb528;

/** Structural frame walk — mirrors dsh-session-persistence-jsonl scanZstdFrames. */
function scanFrames(buf) {
  const frames = [];
  let o = 0;
  while (o < buf.length) {
    const start = o;
    if (buf.length - o < 4) return { frames, tornStart: start };
    if (buf.readUInt32LE(o) !== MAGIC) throw new Error(`invalid frame magic at byte ${o}`);
    o += 4;
    if (o === buf.length) return { frames, tornStart: start };
    const descriptor = buf.readUInt8(o);
    o += 1;
    if ((descriptor & 24) !== 0) throw new Error(`reserved frame-header bit at byte ${o - 1}`);
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buf.length - o < remainingHeaderBytes) return { frames, tornStart: start };
    o += remainingHeaderBytes;
    for (;;) {
      if (buf.length - o < 3) return { frames, tornStart: start };
      const blockHeader = buf.readUIntLE(o, 3);
      o += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error(`reserved block type at byte ${o - 3}`);
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buf.length - o < payloadBytes) return { frames, tornStart: start };
      o += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buf.length - o < 4) return { frames, tornStart: start };
      o += 4;
    }
    frames.push({ start, end: o });
  }
  return { frames };
}

function decodeAll(buf, frames) {
  const parts = new Array(frames.length);
  for (let k = 0; k < frames.length; k++) {
    const { start, end } = frames[k];
    try {
      parts[k] = zstdDecompressSync(buf.subarray(start, end)).toString("utf8");
    } catch (e) {
      throw new Error(`frame at byte ${start} failed validation: ${e.message}`);
    }
  }
  return parts;
}

const path = process.argv[2];
const dryRun = process.argv.includes("--dry-run");
if (!path) {
  console.error("usage: node repair-session-log.mjs <session.jsonl.zstd> [--dry-run]");
  process.exit(2);
}

const before = statSync(path);
const buf = readFileSync(path);
const { frames, tornStart } = scanFrames(buf);
if (frames.length === 0) throw new Error("empty or header-less log");
if (tornStart !== undefined) throw new Error(`torn final frame at byte ${tornStart}; refusing to patch a torn log`);
const parts = decodeAll(buf, frames);
console.log(`frames: ${frames.length}, decoded bytes: ${parts.reduce((n, p) => n + Buffer.byteLength(p), 0)}`);

// Locate poison lines per frame; patch via whole-line replacement so every
// unrelated byte of the frame plaintext stays identical.
let patched = 0;
let alreadyMarked = 0;
let incidental = 0;
const newParts = parts.slice();
const touched = new Set();
const patchedSeqs = [];
for (let k = 0; k < parts.length; k++) {
  const lines = parts[k].split("\n");
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes(`"type":"${RECORD_EVENT}"`)) continue;
    let rec;
    try { rec = JSON.parse(lines[i]); } catch { throw new Error(`unparsable line ${i} of frame ${k}`); }
    if (rec.type !== RECORD_EVENT) { incidental += 1; continue; } // quoted inside message/chunk content
    if (rec.ignorable === true) { alreadyMarked += 1; continue; }
    lines[i] = JSON.stringify({ ...rec, ignorable: true });
    patchedSeqs.push(rec.seq);
    changed = true;
    patched += 1;
  }
  if (changed) {
    newParts[k] = lines.join("\n");
    touched.add(k);
  }
}
if (patched === 0) {
  console.log(`no unmarked agent-approval/record events found (marked: ${alreadyMarked}, incidental matches: ${incidental}); nothing to do`);
  process.exit(0);
}
console.log(`patching ${patched} event(s), seqs: ${patchedSeqs.join(", ")} in frame(s): ${[...touched].join(", ")} (already marked: ${alreadyMarked}, incidental: ${incidental})`);

if (dryRun) {
  console.log("dry-run: no bytes written");
  process.exit(0);
}

// Rebuild: untouched frames keep their exact original bytes.
const chunks = [];
for (let k = 0; k < frames.length; k++) {
  chunks.push(touched.has(k)
    ? zstdCompressSync(Buffer.from(newParts[k], "utf8"), CHECKSUM_OPTIONS)
    : buf.subarray(frames[k].start, frames[k].end));
}
const out = Buffer.concat(chunks);

// Independent verification of the rebuilt artifact BEFORE touching the disk.
const verify = scanFrames(out);
if (verify.frames.length !== frames.length || verify.tornStart !== undefined) {
  throw new Error(`post-build frame scan mismatch: ${verify.frames.length} vs ${frames.length}${verify.tornStart !== undefined ? " (torn)" : ""}`);
}
const verifyParts = decodeAll(out, verify.frames);
const expected = newParts.join("");
const actual = verifyParts.join("");
if (actual !== expected) throw new Error("post-build decode mismatch");
for (const line of actual.split("\n")) {
  if (line.trim() === "") continue;
  JSON.parse(line); // throws on any corrupt record
}
console.log(`verification ok: rebuilt ${out.length} bytes (was ${buf.length}), all ${verify.frames.length} frames decode, ${patched} event(s) ignorable`);

// Write only if the file stayed quiet since we read it.
const again = statSync(path);
if (again.size !== before.size || again.mtimeMs !== before.mtimeMs) {
  throw new Error(`file changed while repairing (size ${before.size} -> ${again.size}); aborting`);
}
const dir = dirname(path);
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
const backupPath = join(dir, `session.jsonl.zstd.bak-pre-ignorable-fix-${stamp}`);
copyFileSync(path, backupPath);
const tmpPath = join(dir, "session.jsonl.zstd.tmp-repair-in-progress");
writeFileSync(tmpPath, out);
renameSync(tmpPath, path);
console.log(`backup: ${backupPath}`);
console.log(`repaired: ${path}`);
