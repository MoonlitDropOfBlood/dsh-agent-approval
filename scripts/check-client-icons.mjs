#!/usr/bin/env node
/** Regression checks for official and legacy Settings navigation icons. */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../client.js", import.meta.url), "utf8");
let checks = 0;
function ok(name) {
  checks += 1;
  console.log("ok   " + name);
}

assert.match(source, /\{ name: "settings\.section\.icon", id: "agent-approval" \}/);
assert.match(source, /settingsNavIcon\.setOfficial\(true\)/);
assert.match(source, /settingsNavIcon\.setOfficial\(false\)/);
assert.match(source, /width: size/);
assert.match(source, /stroke: "currentColor"/);
ok("the official icon is addressed by section id and follows owner size/color");

assert.ok(source.includes('[data-dsh-agent-approval-settings-nav]>span[class*="navIcon"]>svg:first-child'));
assert.ok(source.includes('[data-dsh-agent-approval-settings-icon]::before'));
ok("the legacy CSS hides a wrapped gear and paints only on the icon holder");

// Drive the shipped compatibility closure with a tiny DOM/observer mock. This
// checks marker placement and mutual exclusion rather than merely matching
// source strings.
const beginMarker = "// ---- settings nav icon compatibility";
const endMarker = "// ---- end settings nav icon compatibility";
const begin = source.indexOf(beginMarker);
const end = source.indexOf(endMarker);
assert.ok(begin >= 0 && end > begin, "settings icon extraction markers");
const helperSource = source.slice(source.indexOf("\n", begin) + 1, end);

class FakeElement {
  constructor(textContent) {
    this.textContent = textContent;
    this.attributes = new Set();
    this.iconHolder = null;
  }
  setAttribute(name) {
    this.attributes.add(name);
  }
  removeAttribute(name) {
    this.attributes.delete(name);
  }
  hasAttribute(name) {
    return this.attributes.has(name);
  }
  querySelector(selector) {
    return selector === 'span[class*="navIcon"]' ? this.iconHolder : null;
  }
}

const elements = [];
const document = {
  body: {},
  querySelectorAll(selector) {
    if (selector === '[role="dialog"] nav button') return elements.filter((element) => element.kind === "button");
    const match = /^\[([^\]]+)\]$/.exec(selector);
    if (match) return elements.filter((element) => element.attributes.has(match[1]));
    return [];
  },
};
class FakeMutationObserver {
  static instances = [];
  constructor(callback) {
    this.callback = callback;
    this.active = false;
    FakeMutationObserver.instances.push(this);
  }
  observe() {
    this.active = true;
  }
  disconnect() {
    this.active = false;
  }
}

const { registerSettingsNavIcon, SETTINGS_NAV_MARKER, SETTINGS_NAV_ICON_MARKER } = new Function(
  "document",
  "MutationObserver",
  helperSource + "\nreturn { registerSettingsNavIcon, SETTINGS_NAV_MARKER, SETTINGS_NAV_ICON_MARKER };",
)(document, FakeMutationObserver);

const button = new FakeElement("自动审批");
button.kind = "button";
const otherButton = new FakeElement("常规");
otherButton.kind = "button";
const holder = new FakeElement("");
elements.push(button, otherButton, holder);

const controller = registerSettingsNavIcon("自动审批");
assert.equal(button.hasAttribute(SETTINGS_NAV_MARKER), true);
assert.equal(button.hasAttribute(SETTINGS_NAV_ICON_MARKER), true);
assert.equal(otherButton.hasAttribute(SETTINGS_NAV_MARKER), false);
ok("the legacy fallback marks only the matching button on an old shell");

button.iconHolder = holder;
FakeMutationObserver.instances[0].callback();
assert.equal(button.hasAttribute(SETTINGS_NAV_MARKER), true);
assert.equal(button.hasAttribute(SETTINGS_NAV_ICON_MARKER), false);
assert.equal(holder.hasAttribute(SETTINGS_NAV_ICON_MARKER), true);
ok("a span.navIcon shell moves the fallback mask into the icon holder");

controller.setOfficial(true);
assert.equal(button.hasAttribute(SETTINGS_NAV_MARKER), false);
assert.equal(holder.hasAttribute(SETTINGS_NAV_ICON_MARKER), false);
assert.equal(FakeMutationObserver.instances.every((observer) => !observer.active), true);
ok("the official icon removes all fallback markers and stops DOM observation");

controller.setOfficial(false);
assert.equal(button.hasAttribute(SETTINGS_NAV_MARKER), true);
assert.equal(holder.hasAttribute(SETTINGS_NAV_ICON_MARKER), true);
assert.equal(FakeMutationObserver.instances.at(-1).active, true);
ok("collapse of the official slot restores the legacy fallback cleanly");

controller.setOfficial(true);
controller.dispose();
assert.equal(button.hasAttribute(SETTINGS_NAV_MARKER), false);
assert.equal(holder.hasAttribute(SETTINGS_NAV_ICON_MARKER), false);
assert.equal(FakeMutationObserver.instances.every((observer) => !observer.active), true);
ok("disposal leaves neither markers nor observers behind");

console.log("\nall " + checks + " client-icon checks passed");
