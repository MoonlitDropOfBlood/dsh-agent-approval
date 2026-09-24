/**
 * check-typert-manifest.mjs — dual-generation Typert manifest / Remote
 * descriptor smoke check (run by `npm run check`).
 *
 * Why this exists (v1.7.0): the codec wire contract changed between the two
 * host generations this plugin supports, and each generation REJECTS the
 * other's format at registration time:
 *
 *   - DSH ≤ 0.1.5-rc.3 (`@deepseek-ai/dsh-typert-loader` `requireStrictCodec`,
 *     `dsh-typert-registry` client `validateCodec`) requires a zod-backed
 *     `codec.schema` with a `parse()` method.
 *   - DSH 0.1.7-rc.1+ replaced that with a `codec.create()` factory ("strict
 *     codec has no create() factory"); the gateway parses via
 *     `codec.create().parse(value)`.
 *
 * One manifest therefore carries BOTH fields over the same schema object, and
 * one missing field silently kills every Remote method (Host: the typert-loader
 * refuses the manifest; Client: `$mount` throws and the whole bundle's apply()
 * dies). This check mirrors the exact predicates of both validators (host
 * loader + client registry, both generations) over `typert.host.js` and the
 * CLIENT_REMOTE descriptors captured out of the real `client.js` bundle, then
 * asserts the Host/Client invocation tables agree (id, service/namespace/
 * method, wires, typeSymbols) — the invariant AGENTS.md §1 calls out as
 * load-bearing.
 *
 * The validator predicates are transcriptions of the upstream sources at
 * `@deepseek-ai/dsh-typert-loader` 0.1.5-rc.3 / 0.1.7-rc.1 and
 * `@deepseek-ai/dsh-typert-registry` client 0.1.5-rc.3 / 0.1.7-rc.1. When a
 * third generation changes the contract again, update them together.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

let failures = 0;
function fail(message) {
  failures += 1;
  console.error("FAIL " + message);
}
function ok(message) {
  console.log("ok   " + message);
}

// ---- mirrored validators (see file header) ----------------------------------

function requireString(value, key, subject) {
  if (typeof value[key] !== "string" || value[key].length === 0) {
    throw new Error(`${subject} has a missing or empty ${key}`);
  }
}

/** dsh-typert-loader 0.1.5-rc.3 `requireStrictCodec`. */
function hostCodecPre017(codec, subject) {
  if (typeof codec !== "object" || codec === null) throw new Error(`${subject} must be an object`);
  if (codec.mode !== "strict") throw new Error(`${subject} must use a strict codec`);
  requireString(codec, "typeSymbol", subject);
  if (typeof codec.schema !== "object" || codec.schema === null || !("_zod" in codec.schema) || typeof codec.schema.parse !== "function") {
    throw new Error(`${subject} is not backed by a zod v4 schema`);
  }
}

/** dsh-typert-loader 0.1.7-rc.1 `requireStrictCodec`. */
function hostCodec017(codec, subject) {
  if (typeof codec !== "object" || codec === null) throw new Error(`${subject} must be an object`);
  if (codec.mode !== "strict") throw new Error(`${subject} must use a strict codec`);
  requireString(codec, "typeSymbol", subject);
  for (const method of ["decode", "encode"]) {
    if (codec[method] !== undefined && typeof codec[method] !== "function") {
      throw new Error(`${subject} ${method} must be a function`);
    }
  }
  if (typeof codec.create !== "function") throw new Error(`${subject} has no create() factory`);
}

/** dsh-typert-registry client 0.1.5-rc.3 `validateCodec`. */
function clientCodecPre017(codec, subject) {
  if (codec.mode === "src-json") return;
  requireString(codec, "typeSymbol", subject);
  if (!codec.schema || typeof codec.schema.parse !== "function") {
    throw new Error(`${subject} strict codec has no parse() method`);
  }
}

/** dsh-typert-registry client 0.1.7-rc.1 `validateCodec`. */
function clientCodec017(codec, subject) {
  if (codec.mode === "src-json") return;
  requireString(codec, "typeSymbol", subject);
  if (typeof codec.create !== "function") throw new Error(`${subject} strict codec has no create() factory`);
}

function checkHostCodec(codec, subject) {
  try {
    hostCodecPre017(codec, subject);
    hostCodec017(codec, subject);
  } catch (e) {
    fail(`host codec ${subject}: ${e.message}`);
    return;
  }
  // Both generations must parse with the identical schema instance: `create()`
  // returns the very object the legacy field carries.
  if (codec.create() !== codec.schema) {
    fail(`host codec ${subject}: create() must return the same schema instance as schema (dual-generation parse parity)`);
    return;
  }
  ok(`host codec ${subject} (0.1.5 schema + 0.1.7 create)`);
}

function checkClientCodec(codec, subject) {
  try {
    clientCodecPre017(codec, subject);
    clientCodec017(codec, subject);
  } catch (e) {
    fail(`client codec ${subject}: ${e.message}`);
    return;
  }
  const created = codec.create();
  if (typeof created.parse !== "function" || created.parse("x") !== "x" || codec.schema.parse("x") !== "x") {
    fail(`client codec ${subject}: passthrough parse must be identity on both schema and create()`);
    return;
  }
  ok(`client codec ${subject} (0.1.5 schema + 0.1.7 create)`);
}

// ---- 1. Host manifest --------------------------------------------------------

const { TYPERT } = await import(pathToFileURL(join(root, "typert.host.js")).href);

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
if (TYPERT.package !== pkg.name) {
  fail(`TYPERT.package ${JSON.stringify(TYPERT.package)} must equal package.json name ${JSON.stringify(pkg.name)}`);
} else {
  ok(`TYPERT.package matches package name (${pkg.name})`);
}
if (TYPERT.face !== "host") fail('TYPERT.face must be "host"');

for (const invocation of TYPERT.invocations) {
  const id = invocation.id;
  for (const key of ["id", "service", "namespace", "method"]) {
    if (typeof invocation[key] !== "string" || invocation[key].length === 0) {
      fail(`invocation ${id}: missing or empty ${key}`);
    }
  }
  for (const parameter of invocation.parameters) {
    if (parameter.source !== "json") fail(`invocation ${id} parameter ${parameter.name}: only "json" source is expected here`);
    checkHostCodec(parameter.codec, `${id} parameter ${parameter.name}`);
  }
  checkHostCodec(invocation.result, `${id} result`);
}

// ---- 2. Client Remote descriptors, captured from the real bundle -------------

// Execute the shipped bundle factory with stubbed browser/module surfaces and
// capture the contribution `apply()` mounts. The bundle only DEFINES its
// components inside the factory, so the stubs below cover its apply() path
// (module resolve, DOM style injection, icon observers, slot registration)
// and nothing else.
let bundleRegistration;
globalThis.window = {
  __ModuleLoader__: {
    load: (entry) => {
      bundleRegistration = entry;
    },
  },
};
globalThis.document = {
  createElement: () => ({ textContent: "", remove() {} }),
  head: { appendChild() {} },
  querySelectorAll: () => [],
};
globalThis.MutationObserver = class {
  observe() {}
  disconnect() {}
};

await import(pathToFileURL(join(root, "client.js")).href);
if (!bundleRegistration || bundleRegistration.id !== pkg.name) {
  fail(`client bundle registration id must equal package name (${pkg.name})`);
  process.exit(1);
}

const bundleModule = bundleRegistration.factory((spec) => {
  if (spec === "react") {
    return {
      createElement: () => null,
      useState: (initial) => [initial, () => {}],
      useEffect: () => {},
    };
  }
  if (spec === "@deepseek-ai/dsh-client-ui-primitives") return { Button: () => null };
  throw new Error(`unexpected module-table require: ${spec}`);
});

const mounted = [];
const stubCtx = {
  remote: {
    $mount: async (contribution) => {
      mounted.push(contribution);
      return () => Promise.resolve();
    },
  },
  get: () => ({}),
  effect: () => () => {},
  slots: {
    inject: (name, register) => register(),
    register: () => undefined,
  },
};
await bundleModule.apply(stubCtx);

const CLIENT_REMOTE = mounted[0];
if (!CLIENT_REMOTE || mounted.length !== 1) {
  fail("client apply() must mount exactly one Remote contribution");
  process.exit(1);
}

for (const descriptor of CLIENT_REMOTE.descriptors) {
  for (const parameter of descriptor.parameters) {
    checkClientCodec(parameter.codec, `${descriptor.id} parameter ${parameter.name}`);
  }
  checkClientCodec(descriptor.result, `${descriptor.id} result`);
}

// ---- 3. Host/Client invocation table parity ----------------------------------

const hostById = new Map(TYPERT.invocations.map((i) => [i.id, i]));
const clientById = new Map(CLIENT_REMOTE.descriptors.map((d) => [d.id, d]));

for (const [id] of hostById) {
  if (!clientById.has(id)) fail(`invocation ${id} exists on the Host manifest but not in CLIENT_REMOTE`);
}
for (const [id] of clientById) {
  if (!hostById.has(id)) fail(`invocation ${id} exists in CLIENT_REMOTE but not on the Host manifest`);
}
for (const [id, host] of hostById) {
  const client = clientById.get(id);
  if (client === undefined) continue;
  for (const key of ["service", "namespace", "method"]) {
    if (host[key] !== client[key]) {
      fail(`invocation ${id}: ${key} mismatch (host ${JSON.stringify(host[key])} vs client ${JSON.stringify(client[key])})`);
    }
  }
  if (host.result.typeSymbol !== client.result.typeSymbol) {
    fail(`invocation ${id}: result typeSymbol mismatch (${host.result.typeSymbol} vs ${client.result.typeSymbol})`);
  }
  if (host.parameters.length !== client.parameters.length) {
    fail(`invocation ${id}: parameter count mismatch (${host.parameters.length} vs ${client.parameters.length})`);
  } else {
    for (let i = 0; i < host.parameters.length; i++) {
      const hp = host.parameters[i];
      const cp = client.parameters[i];
      if (hp.name !== cp.name || hp.wire !== cp.wire || hp.source !== cp.source) {
        fail(`invocation ${id} parameter ${hp.name}: name/wire/source mismatch against client descriptor`);
      }
      if (hp.codec.typeSymbol !== cp.codec.typeSymbol) {
        fail(`invocation ${id} parameter ${hp.name}: typeSymbol mismatch (${hp.codec.typeSymbol} vs ${cp.codec.typeSymbol})`);
      }
    }
  }
}
if (failures === 0) ok(`invocation tables agree across Host/Client (${hostById.size} invocations)`);

// ---- 4. Optional deep check: the REAL TypertRegistry validators --------------

// Point DSH_TYPERT_REGISTRY (and optionally DSH_TYPERT_REGISTRY_2 for a second
// host generation) at `@deepseek-ai/dsh-typert-registry/lib/index.js` from a
// real DSH install to run the genuine registration path instead of the mirrored
// predicates above: `register()` executes upstream's validateInvocation over the
// Host manifest and `remotes.register()` over the Client descriptors.
for (const envName of ["DSH_TYPERT_REGISTRY", "DSH_TYPERT_REGISTRY_2"]) {
  const target = process.env[envName];
  if (!target) continue;
  try {
    const { TypertRegistry } = await import(pathToFileURL(target).href);
    const stubCtx = {
      reflect: { provide() {} },
      logger: { warn() {} },
      effect(fn) {
        const iterator = fn();
        iterator.next();
        return () => {};
      },
    };
    const registry = new TypertRegistry(stubCtx);
    registry.register(TYPERT);
    registry.remotes.register(CLIENT_REMOTE);
    ok(`real TypertRegistry accepted Host manifest + Client descriptors (${envName} = ${target})`);
  } catch (e) {
    fail(`real TypertRegistry rejected the contribution (${envName} = ${target}): ${e.message}`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall typert manifest checks passed");

