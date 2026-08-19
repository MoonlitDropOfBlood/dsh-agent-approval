#!/usr/bin/env node
/**
 * Local installer for dsh-agent-approval.
 *
 * Installs the plugin into the DSH web profile:
 *   1. Copies this package (the project root) into
 *      `<DSH_HOME>/profiles/web/node_modules/dsh-agent-approval/`.
 *   2. Ensures the profile's `cordis.patch.yml` mounts it via an `insert` row.
 *   3. Reports whether a DSH restart is required.
 *
 * Usage:
 *   node scripts/install.mjs            # install into default profile (web)
 *   DSH_HOME=<path> node scripts/install.mjs
 *   DSH_PROFILE=<name> node scripts/install.mjs
 */
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, "..");
const PKG_NAME = "dsh-agent-approval";

const DSH_HOME = process.env.DSH_HOME || join(homedir(), ".dsh");
const PROFILE = process.env.DSH_PROFILE || "web";
const PROFILE_DIR = join(DSH_HOME, "profiles", PROFILE);
const NODE_MODULES = join(PROFILE_DIR, "node_modules");
const TARGET = join(NODE_MODULES, PKG_NAME);
const PATCH_FILE = join(PROFILE_DIR, "cordis.patch.yml");

/** Files shipped to the profile. */
const SHIP = ["package.json", "index.js", "client.js", "typert.host.js"];

function log(prefix, message) {
  console.log(`[${prefix}] ${message}`);
}

function pkgJson() {
  return JSON.parse(readFileSync(join(PROJECT_ROOT, "package.json"), "utf8"));
}

async function ensureProfile() {
  await mkdir(NODE_MODULES, { recursive: true });
}

async function copyPackage() {
  await mkdir(TARGET, { recursive: true });
  for (const file of SHIP) {
    const src = join(PROJECT_ROOT, file);
    if (!existsSync(src)) throw new Error(`missing shipped file: ${file}`);
    await cp(src, join(TARGET, file));
  }
  log("install", `copied plugin to ${TARGET}`);
}

/** Build the insert block for the plugin. */
function insertBlock() {
  return (
    "# --- dsh-agent-approval (managed by scripts/install.mjs) ---\n" +
    "- insert:\n" +
    "  - id: agent-approval\n" +
    `    name: '${PKG_NAME}'\n`
  );
}

/**
 * Build the `- id: permission` override that registers the Agent 审批 entry
 * in the permission-preset table (the composer /permission menu). A patch
 * REPLACES the targeted row's whole config rather than merging, so the full
 * table is restated here — keep it in sync with the dsh-base bundle's row
 * when upgrading DSH. Declaration order IS menu order: agent-approval sits
 * between workspace-write and danger-full-access (above Full access).
 */
function permissionOverrideBlock() {
  return (
    "# --- dsh-agent-approval: register the Agent 审批 preset in the permission menu ---\n" +
    "# (managed by scripts/install.mjs — restates the full presets table because a\n" +
    "# patch replaces the `permission` row's whole config; re-sync with dsh-base on upgrade)\n" +
    "- id: permission\n" +
    "  name: '@deepseek-ai/dsh-permission-presets'\n" +
    "  config:\n" +
    "    presets:\n" +
    "      read-only:\n" +
    "        sandbox: read-only\n" +
    "        approval: ask\n" +
    "      workspace-write:\n" +
    "        sandbox: workspace-write\n" +
    "        approval: ask\n" +
    "      agent-approval:\n" +
    "        sandbox: workspace-write\n" +
    "        approval: ask\n" +
    "        name: Agent 审批\n" +
    "        description: workspace-write base; an independent approval agent judges every escalation, risky ones are rejected.\n" +
    "      danger-full-access:\n" +
    "        sandbox: danger-full-access\n" +
    "        approval: never\n"
  );
}

/** First line of the managed permission-override block (its identity marker). */
const PERMISSION_BLOCK_MARKER = "# --- dsh-agent-approval: register the Agent 审批 preset in the permission menu ---";

/**
 * Remove any previously managed permission-override block (from the marker
 * line up to the next `# ---` section header or EOF), so a re-install can
 * replace it wholesale — that is how table reordering self-heals without
 * hand-editing the profile patch.
 */
function stripManagedPermissionBlock(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l === PERMISSION_BLOCK_MARKER);
  if (start === -1) return text;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith("# --- ") && lines[i] !== PERMISSION_BLOCK_MARKER) {
      end = i;
      break;
    }
  }
  const kept = lines.slice(0, start).concat(lines.slice(end));
  return kept.join("\n").replace(/\n{3,}$/, "\n");
}

/** True when the patch body is effectively empty (a bare `[]` or blank). */
function isEmptyPatch(text) {
  const body = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
  return body.length === 0 || (body.length === 1 && body[0] === "[]");
}

/**
 * Merge an `insert` row for the plugin into the profile patch (idempotent).
 * If the existing patch is an empty placeholder (`[]`), it is replaced so the
 * file stays a single valid YAML list.
 */
async function ensurePatch() {
  let text = "";
  if (existsSync(PATCH_FILE)) {
    text = await readFile(PATCH_FILE, "utf8");
  }
  let changed = false;
  if (!text.includes(`name: '${PKG_NAME}'`)) {
    const block = insertBlock();
    if (isEmptyPatch(text)) {
      text = block;
      log("patch", `replaced empty patch in ${PATCH_FILE}`);
    } else {
      const trimmed = text.trimEnd();
      text = trimmed.length === 0 ? block : trimmed + "\n\n" + block;
      log("patch", `added mount row to ${PATCH_FILE}`);
    }
    changed = true;
  } else {
    log("patch", "plugin row already present, skipping");
  }
  // Always strip any previously managed block and append the current one —
  // idempotent by construction, and table reorders self-heal without
  // hand-editing the profile patch.
  {
    const stripped = stripManagedPermissionBlock(text).trimEnd();
    text = stripped.length === 0 ? permissionOverrideBlock() : stripped + "\n\n" + permissionOverrideBlock();
    log("patch", `rewrote permission preset override in ${PATCH_FILE}`);
    changed = true;
  }
  if (changed) await writeFile(PATCH_FILE, text, "utf8");
  return changed;
}

// ---- permission-menu glyph patch ---------------------------------------------

/**
 * The shipped ui-conversation bundle hardcodes the permission glyphs (menu
 * rows + the composer trigger) keyed by the three stock preset values —
 * "host-configured names outside the design set get none" (source comment).
 * There is no public registration seam, so this patches the compiled map in
 * place with an `agent-approval` entry: the same stroked shield as the stock
 * presets with a filled AI-sparkle inside. Idempotent; a DSH upgrade
 * reinstalls the pristine bundle, and re-running the installer re-patches it.
 */
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

/**
 * Best-effort dependency availability check. DSH hoists shared deps to
 * `<DSH_HOME>/profiles/node_modules`, so a module under the profile resolves
 * them by walking up parent directories and probing `<dir>/node_modules`.
 * Reproduce that chain from the profile directory upward.
 */
async function checkDeps() {
  const deps = ["zod", "@deepseek-ai/cordis", "@deepseek-ai/dsh-typert-protocol"];
  const missing = [];
  for (const dep of deps) {
    let found = false;
    let dir = PROFILE_DIR;
    for (let depth = 0; depth < 5 && !found; depth++) {
      if (existsSync(join(dir, "node_modules", dep, "package.json"))) found = true;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    if (!found) missing.push(dep);
  }
  if (missing.length) {
    log("warn", `dependencies not resolvable from profile: ${missing.join(", ")}`);
    log(
      "warn",
      `install the deps into the profile (dsh plugin add / npm install) so DSH ` +
        `can resolve them, then restart DSH.`,
    );
  } else {
    log("ok", "dependencies resolvable from the DSH shared node_modules layer");
  }
}

async function main() {
  const info = pkgJson();
  log("info", `installing ${info.name}@${info.version} into DSH profile "${PROFILE}"`);
  await ensureProfile();
  await copyPackage();
  await ensurePatch();
  await patchPermissionGlyph();
  await checkDeps();
  log("done", `restart DSH (node <dsh bin> web --profile ${PROFILE}) for the plugin to take effect.`);
}

main().catch((error) => {
  console.error(`[install] failed: ${error && error.message ? error.message : error}`);
  process.exitCode = 1;
});
