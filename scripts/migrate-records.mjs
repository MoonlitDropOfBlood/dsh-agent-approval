#!/usr/bin/env node
/**
 * One-time migration: dsh-agent-approval v1.4.x → v1.5.1+ audit storage.
 *
 * v1.4.x kept every approval verdict in ONE global JSONL file:
 *     <DSH_HOME>/agent-approval/records.jsonl
 * where each line's `sessionId` field holds only the FIRST 8 CHARACTERS of
 * the session UUID (the `session-` prefix was stripped by `shortId()`), plus
 * a batch of historical rows broken by the naive-slice bug whose `sessionId`
 * is literally `"session-"` (unattributable — skipped).
 *
 * v1.5.1+ stores each session's records in a SIDECAR file inside that
 * session's own persistence directory:
 *     <DSH_HOME>/sessions/<workspace>/<session-id>/agent-approval.jsonl
 * (the same directory the session's `session.jsonl.zstd` log lives in — the
 * plugin resolves it at runtime via `sessionPersistence.locate(header)`).
 *
 * This script reads the legacy file, matches every attributable record to
 * its session directory by UUID prefix, appends the records (deduplicated)
 * to the per-session sidecar, and renames the legacy file to
 * `records.jsonl.migrated` so a rerun cannot double-migrate. Idempotent:
 * lines already present in a sidecar are skipped, and renaming the source
 * makes a second run a no-op.
 *
 * Usage:  node scripts/migrate-records.mjs [--dry-run]
 * Nothing else touches DSH's own session log files.
 */

import { readdir, readFile, writeFile, appendFile, rename, access } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const dryRun = process.argv.includes("--dry-run");
const dshHome = process.env.DSH_HOME && isAbsolute(process.env.DSH_HOME)
  ? resolve(process.env.DSH_HOME)
  : join(homedir(), ".dsh");
const legacyFile = join(dshHome, "agent-approval", "records.jsonl");
const sessionsRoot = join(dshHome, "sessions");
const SIDECAR = "agent-approval.jsonl";

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

if (!(await exists(legacyFile))) {
  console.log(`no legacy audit file at ${legacyFile} — nothing to migrate`);
  process.exit(0);
}

// 1. Enumerate every session directory: <sessionsRoot>/<workspace>/<session-id>
const sessionDirs = []; // { dir, uuid } where uuid = session id minus "session-"
for (const workspace of await readdir(sessionsRoot).catch(() => [])) {
  const wsDir = join(sessionsRoot, workspace);
  const entries = await readdir(wsDir).catch(() => []);
  for (const name of entries) {
    if (!name.startsWith("session-")) continue;
    sessionDirs.push({ dir: join(wsDir, name), uuid: name.slice("session-".length) });
  }
}
const byPrefix = new Map(); // first-8-of-uuid -> [{ dir, uuid }]
for (const entry of sessionDirs) {
  const prefix = entry.uuid.slice(0, 8);
  if (prefix.length < 8) continue;
  if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
  byPrefix.get(prefix).push(entry);
}

// 2. Parse the legacy records.
const text = await readFile(legacyFile, "utf8");
const records = [];
let corrupt = 0;
for (const raw of text.split("\n")) {
  const line = raw.trim();
  if (line === "") continue;
  try {
    const parsed = JSON.parse(line);
    if (parsed && typeof parsed === "object" && typeof parsed.at === "string") records.push(parsed);
    else corrupt += 1;
  } catch {
    corrupt += 1;
  }
}

// 3. Route each record to its session sidecar.
/** prefix -> { lines: string[], count: number } */
const perSession = new Map();
let migrated = 0;
let unattributable = 0;
let ambiguous = 0;
let noDirectory = 0;
for (const record of records) {
  const short = String(record.sessionId ?? "");
  if (short === "session-" || short.length !== 8) {
    unattributable += 1; // the historical naive-slice bug ("session-")
    continue;
  }
  const candidates = byPrefix.get(short);
  if (candidates === undefined) {
    noDirectory += 1; // session never created on this install / already deleted
    continue;
  }
  if (candidates.length > 1) {
    ambiguous += 1; // 8-char prefix collision — refuse to guess
    continue;
  }
  const key = candidates[0].dir;
  if (!perSession.has(key)) perSession.set(key, { lines: [], count: 0 });
  const bucket = perSession.get(key);
  bucket.lines.push(JSON.stringify({ ...record, sessionId: candidates[0].uuid ? `session-${candidates[0].uuid}` : record.sessionId }));
  bucket.count += 1;
  migrated += 1;
}

// 4. Write sidecars (dedup against existing lines) unless --dry-run.
console.log(`legacy records: ${records.length} (corrupt lines: ${corrupt})`);
console.log(`attributable & matched: ${migrated} across ${perSession.size} session(s)`);
console.log(`skipped: ${unattributable} unattributable ("session-" bug), ${noDirectory} without a session directory, ${ambiguous} ambiguous prefix`);
if (dryRun) {
  for (const [dir, bucket] of perSession) console.log(`  would add ${bucket.count} -> ${join(dir, SIDECAR)}`);
  console.log("dry run — nothing written");
  process.exit(0);
}
for (const [dir, bucket] of perSession) {
  const sidecar = join(dir, SIDECAR);
  const existing = new Set();
  if (await exists(sidecar)) {
    for (const raw of (await readFile(sidecar, "utf8")).split("\n")) {
      const line = raw.trim();
      if (line !== "") existing.add(line);
    }
  }
  const fresh = bucket.lines.filter((line) => !existing.has(line));
  if (fresh.length === 0) {
    console.log(`  ${sidecar}: already up to date (${bucket.count} duplicate)`);
    continue;
  }
  await appendFile(sidecar, fresh.join("\n") + "\n", "utf8");
  console.log(`  ${sidecar}: appended ${fresh.length} (of ${bucket.count})`);
}

// 5. Retire the legacy file so a rerun cannot double-migrate.
const retired = `${legacyFile}.migrated`;
await writeFile(retired, text, "utf8");
await rename(legacyFile, retired);
console.log(`legacy file retired: ${legacyFile} -> ${retired}`);
