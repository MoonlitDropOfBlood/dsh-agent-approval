#!/usr/bin/env node
/**
 * Patch the Agent 审批 permission-menu glyph into the shipped
 * `dsh-client-ui-conversation` bundle.
 *
 * Standard-install note: mounting this plugin (`dsh plugin --profile web add
 * <path-or-package>`) applies the cordis.patch.yml bundle patch — plugin row +
 * `permission` preset table override. It cannot touch this glyph, because the
 * icon map is compiled into the official client bundle (there is no public
 * registration seam). This script is the one local, optional step that
 * restores the menu icon for the Agent 审批 entry. It is idempotent; a DSH
 * upgrade reinstalls the pristine bundle and this script re-patches it.
 * Skipping it only means the /permission menu row shows no icon — the preset
 * itself still works.
 *
 * Usage:
 *   node scripts/patch-glyph.mjs            # patch into default DSH_HOME
 *   DSH_HOME=<path> node scripts/patch-glyph.mjs
 */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const DSH_HOME = process.env.DSH_HOME || join(homedir(), ".dsh");

const GLYPH_TARGET = join(
  DSH_HOME,
  "profiles",
  "node_modules",
  "@deepseek-ai",
  "dsh-client-ui-conversation",
  "lib",
  "client.js",
);
const GLYPH_ANCHOR = "const permissionGlyphs = {";
const GLYPH_MARKER = '"agent-approval": (0, react_jsx_runtime.jsx)';
const GLYPH_ENTRY =
  '"agent-approval": (0, react_jsx_runtime.jsx)("svg", { width: "16", height: "16", viewBox: "0 0 16 16", fill: "none", "aria-hidden": true, children: [(0, react_jsx_runtime.jsx)("path", { d: "M8.20554 0.899994L14.7901 3.36857V7.01026C14.7901 12 11.0466 14.2103 8.20554 15.3C5.36446 14.2103 1.62012 12 1.62012 7.01026V3.36857L8.20554 0.899994Z", stroke: "currentColor", strokeWidth: "1.31831", strokeLinejoin: "round" }), (0, react_jsx_runtime.jsx)("path", { d: "M8 3.2L9.1 5.9L11.8 7L9.1 8.1L8 10.8L6.9 8.1L4.2 7L6.9 5.9Z", fill: "currentColor" })] }),\n';

function log(prefix, message) {
  console.log(`[${prefix}] ${message}`);
}

async function patchPermissionGlyph() {
  if (!existsSync(GLYPH_TARGET)) {
    log("warn", `glyph target not found, skipping: ${GLYPH_TARGET}`);
    return;
  }
  const text = await readFile(GLYPH_TARGET, "utf8");
  if (text.includes(GLYPH_MARKER)) {
    log("glyph", "agent-approval glyph already present, skipping");
    return;
  }
  const at = text.indexOf(GLYPH_ANCHOR);
  if (at === -1) {
    log("warn", "permissionGlyphs map not found in the shipped bundle — DSH version changed? Skipping glyph patch.");
    return;
  }
  const insertAt = at + GLYPH_ANCHOR.length;
  const next = text.slice(0, insertAt) + "\n" + GLYPH_ENTRY + text.slice(insertAt);
  await writeFile(GLYPH_TARGET, next, "utf8");
  log("glyph", `patched agent-approval glyph into ${GLYPH_TARGET}`);
}

patchPermissionGlyph().catch((error) => {
  console.error(`[patch-glyph] failed: ${error && error.message ? error.message : error}`);
  process.exitCode = 1;
});
