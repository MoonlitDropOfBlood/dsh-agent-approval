/**
 * dsh-agent-approval — Client half (web bundle).
 *
 * Rendered by the DSH web shell via `window.__ModuleLoader__.load`. Adds:
 *
 *   1. An「审批」tab in the conversation window's view ring
 *      (`conversation.view`, right next to 轨迹): the per-session approval
 *      audit trail. The Host folds the records out of a sidecar file inside
 *      the session's OWN persistence directory
 *      (`<sessionDir>/agent-approval.jsonl`), so the audit follows the
 *      session — restored with it after a restart, gone when the session is
 *      deleted. Rows offer the one-click「加白」rule shortcut.
 *
 *   2. A "自动审批" page in the Settings panel (`settings.section`):
 *      approval model picker (provider + model, the harness default, or the
 *      TypeSafe Jev direct HTTP backend with its API key / endpoint /
 *      confidence-gate settings), judge timeout setting (fail-closed), the
 *      list of sessions with the mode enabled (session-list title +
 *      workspace), and the allow/deny rule table.
 *
 * Session-level on/off lives in the /permission menu (the "自动审批"
 * preset, registered by the package's cordis.patch.yml bundle patch) and the
 * /agent-approval command — deliberately NO composer chip: a second toggle
 * beside the permission menu it belongs to was redundant.
 *
 * Host communication goes through the `agentApproval` Remote namespace
 * (`ctx.remote.agentApproval.*`), published by the Host half in `index.js`.
 */
window.__ModuleLoader__.load({
  id: "@duke-dsh-plugins/dsh-agent-approval",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");
    // Official DSH design-system atoms (Button etc.). The Button variants are
    // backed by the `--dsw-alias-button-*` token family, so light/dark themes
    // are automatic (same pattern as dsh-memory-manager).
    const ui = require("@deepseek-ai/dsh-client-ui-primitives");

    // ---- CSS (package-owned, uses DSH design tokens) -------------------------
    const CSS = `
.aapr-page{display:flex;flex-direction:column;gap:16px;color:var(--dsw-alias-label-primary);font-size:13px;max-width:820px}
.aapr-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:12px 14px;background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;gap:8px}
.aapr-card h3{margin:0;font-size:13px;font-weight:600}
.aapr-muted{color:var(--dsw-alias-label-secondary);line-height:1.5}
.aapr-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.aapr-select,.aapr-input{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:4px 8px;font-size:12px;max-width:340px}
.aapr-chip{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:2px 10px;background:var(--dsw-alias-bg-layer-2);max-width:100%}
.aapr-chip-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:320px}
.aapr-chip-id{color:var(--dsw-alias-label-secondary);font-family:monospace;font-size:11px}
.aapr-chip button{background:none;border:none;color:var(--dsw-alias-state-error-primary);cursor:pointer;font-size:12px;padding:0 2px}
.aapr-wrap{overflow-x:auto}
.aapr-table{width:100%;border-collapse:collapse;font-size:12px}
.aapr-table th{text-align:left;color:var(--dsw-alias-label-secondary);font-weight:500;padding:4px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);white-space:nowrap}
.aapr-table td{padding:4px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);vertical-align:top}
.aapr-cell{max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:normal}
.aapr-ok{color:var(--dsw-alias-state-success-primary);white-space:nowrap}
.aapr-no{color:var(--dsw-alias-state-error-primary);white-space:nowrap}
.aapr-input-wide{flex:1;min-width:220px;max-width:none}
.aapr-rule-match{font-family:monospace;font-size:11px;color:var(--dsw-alias-label-secondary)}
.aapr-rule-del,.aapr-whitelist{background:none;border:none;cursor:pointer;font-size:12px;padding:0 2px}
.aapr-rule-del{color:var(--dsw-alias-state-error-primary)}
.aapr-whitelist{color:var(--dsw-alias-label-secondary)}
.aapr-whitelist:hover{color:var(--dsw-alias-label-primary)}

/* Conversation-window「审批」tab: fills the view area below the tab strip
   with the same token family as the Settings cards, so the audit ledger
   reads native beside 轨迹. */
.aapr-view{height:100%;overflow:auto;padding:12px 16px 16px;color:var(--dsw-alias-label-primary);font-size:13px}
.aapr-view-inner{display:flex;flex-direction:column;gap:10px;max-width:980px;margin:0 auto}
.aapr-view-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.aapr-view-title{font-size:13px;font-weight:600;margin:0}
.aapr-state-on{color:var(--dsw-alias-state-success-primary)}
.aapr-state-off{color:var(--dsw-alias-label-secondary)}

/* Settings nav icon: DSH 0.1.x settings.section only projects id/order/
   label, and the settings shell paints a generic gear for every external
   section (client-ui-settings-general's navIcon()). registerSettingsNavIcon
   marks our own nav row; hide the shell's gear and draw the shield-check
   Lucide glyph as a currentColor mask so it follows the native nav
   hover/active colors without changing the shell's 16px icon rhythm. */
[data-dsh-agent-approval-settings-nav]>svg:first-child{display:none}
[data-dsh-agent-approval-settings-nav]::before{content:'';flex:none;width:16px;height:16px;background:currentColor;-webkit-mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z'/%3E%3Cpath d='m9 12 2 2 4-4'/%3E%3C/svg%3E") center/contain no-repeat;mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z'/%3E%3Cpath d='m9 12 2 2 4-4'/%3E%3C/svg%3E") center/contain no-repeat}

/* /permission menu + composer permission trigger: both pick icons from the
   permissionGlyphs map compiled into the official dsh-client-ui-conversation
   bundle ("host-configured names outside the design set get none") — there is
   no public registration seam, so an external preset row renders with no icon
   element at all. registerPermissionGlyphIcon marks the Agent 审批 menu row
   ([role=menu] button[role=menuitem]) and the composer trigger button; CSS
   draws the same shield + AI-star glyph patch-glyph.mjs used, as a
   currentColor mask so hover/selected/disabled colors all follow the shell.
   Scope guard: only menus that already render the official glyph set
   (sibling rows carry the Menu primitive's itemIcon span) qualify — the composer /permission
   menu does; the settings PermissionRow dropdown (settings.general 权限 row,
   portaled to <body>) renders NO icons for any preset, so an icon there
   would be an uninvited extra and is deliberately left unmarked. */
[data-dsh-agent-approval-perm-item]::before,
[data-dsh-agent-approval-perm-trigger]::before{content:'';flex:none;width:16px;height:16px;background:currentColor;-webkit-mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 16 16' fill='none'%3E%3Cpath d='M8.20554 0.899994L14.7901 3.36857V7.01026C14.7901 12 11.0466 14.2103 8.20554 15.3C5.36446 14.2103 1.62012 12 1.62012 7.01026V3.36857L8.20554 0.899994Z' stroke='black' stroke-width='1.31831' stroke-linejoin='round'/%3E%3Cpath d='M8 3.2L9.1 5.9L11.8 7L9.1 8.1L8 10.8L6.9 8.1L4.2 7L6.9 5.9Z' fill='black'/%3E%3C/svg%3E") center/contain no-repeat;mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 16 16' fill='none'%3E%3Cpath d='M8.20554 0.899994L14.7901 3.36857V7.01026C14.7901 12 11.0466 14.2103 8.20554 15.3C5.36446 14.2103 1.62012 12 1.62012 7.01026V3.36857L8.20554 0.899994Z' stroke='black' stroke-width='1.31831' stroke-linejoin='round'/%3E%3Cpath d='M8 3.2L9.1 5.9L11.8 7L9.1 8.1L8 10.8L6.9 8.1L4.2 7L6.9 5.9Z' fill='black'/%3E%3C/svg%3E") center/contain no-repeat}

/* 自动审查 (agent-review) menu row: same shield-glyph treatment as the
   自动审批 row (same glyph-set guard), and hidden outright while the Jev gate
   is closed (body[data-...-review-gate="off"], set from getState()
   .reviewAvailable) — the mode cannot run without the Jev judge, so the host
   would bounce the selection back anyway. */
[data-dsh-agent-approval-review-gate="off"] [data-dsh-agent-approval-review-item]{display:none}
[data-dsh-agent-approval-review-item]::before{content:'';flex:none;width:16px;height:16px;background:currentColor;-webkit-mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 16 16' fill='none'%3E%3Cpath d='M8.20554 0.899994L14.7901 3.36857V7.01026C14.7901 12 11.0466 14.2103 8.20554 15.3C5.36446 14.2103 1.62012 12 1.62012 7.01026V3.36857L8.20554 0.899994Z' stroke='black' stroke-width='1.31831' stroke-linejoin='round'/%3E%3Cpath d='M8 3.2L9.1 5.9L11.8 7L9.1 8.1L8 10.8L6.9 8.1L4.2 7L6.9 5.9Z' fill='black'/%3E%3C/svg%3E") center/contain no-repeat;mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 16 16' fill='none'%3E%3Cpath d='M8.20554 0.899994L14.7901 3.36857V7.01026C14.7901 12 11.0466 14.2103 8.20554 15.3C5.36446 14.2103 1.62012 12 1.62012 7.01026V3.36857L8.20554 0.899994Z' stroke='black' stroke-width='1.31831' stroke-linejoin='round'/%3E%3Cpath d='M8 3.2L9.1 5.9L11.8 7L9.1 8.1L8 10.8L6.9 8.1L4.2 7L6.9 5.9Z' fill='black'/%3E%3C/svg%3E") center/contain no-repeat}
.aapr-mode-review{margin-left:6px;font-size:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:4px;padding:0 4px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
`;

    // ---- Settings nav icon --------------------------------------------------
    // DSH 0.1.x does not yet carry an icon through the settings.section
    // registration contract: its shell projects only id/order/label and
    // paints a generic gear for every external section. Mark only this
    // plugin's localized nav row so the CSS above can replace the fallback
    // gear; the disposer clears the marker for HMR / plugin disable.
    // Settings nav icon row text === settings.section label === permission
    // preset display name (the two stay identical by convention — see
    // AGENTS.md): 自动审批 as of v1.8.0 (renamed from "Agent 审批").
    const SETTINGS_LABEL = "自动审批";
    /** The agent-review preset display name (permission menu row). */
    const REVIEW_LABEL = "自动审查";
    const SETTINGS_NAV_MARKER = "data-dsh-agent-approval-settings-nav";

    function registerSettingsNavIcon(label) {
      let disposed = false;
      const sync = function () {
        if (disposed) return;
        const currentLabel = String(label).trim();
        const buttons = document.querySelectorAll('[role="dialog"] nav button');
        for (let i = 0; i < buttons.length; i++) {
          const button = buttons[i];
          const text = button.textContent ? button.textContent.trim() : "";
          if (currentLabel.length > 0 && text === currentLabel) {
            button.setAttribute(SETTINGS_NAV_MARKER, "");
          } else {
            button.removeAttribute(SETTINGS_NAV_MARKER);
          }
        }
      };
      sync();
      const observer = new MutationObserver(sync);
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      return function () {
        disposed = true;
        observer.disconnect();
        const marked = document.querySelectorAll("[" + SETTINGS_NAV_MARKER + "]");
        for (let i = 0; i < marked.length; i++) marked[i].removeAttribute(SETTINGS_NAV_MARKER);
      };
    }

    // ---- /permission menu + composer trigger icon ----------------------------
    // The permission surfaces (menu rows and the composer trigger button) pick
    // icons from the permissionGlyphs map compiled into the official
    // dsh-client-ui-conversation bundle — external presets get no icon element
    // at all (see PermissionSelect: `icon === void 0 ? {} : { icon }`). Mark
    // the two surfaces whose label is this preset's display name so the CSS
    // above can paint the glyph; the disposer clears both markers.
    const PERM_ITEM_MARKER = "data-dsh-agent-approval-perm-item";
    const PERM_TRIGGER_MARKER = "data-dsh-agent-approval-perm-trigger";

    function registerPermissionGlyphIcon(label) {
      let disposed = false;
      const sync = function () {
        if (disposed) return;
        const currentLabel = String(label).trim();
        if (currentLabel.length === 0) return;
        // 1) /permission menu rows: Menu renders [itemIcon?][itemLabel][check?]
        //    inside button[role=menuitem]; an icon-less row starts at the label.
        //    Glyph-set guard: only mark our row in menus where the official
        //    presets already render their permissionGlyphs (sibling rows carry
        //    the Menu primitive's icon span). The class-name substring is
        //    "itemIcon" (v1.7.0, widened from "_itemIcon_"): CSS-modules compiles
        //    the source name differently across host generations
        //    (`_itemIcon_<hash>_` vs `<hash>_itemIcon`), and the Menu moved from
        //    dsh-client-ui-conversation to dsh-client-ui-permission-presets in
        //    0.1.7-rc.1. The composer /permission menu qualifies; the settings
        //    PermissionRow dropdown (portaled to <body>, no item icons for any
        //    preset) does NOT, so the glyph no longer leaks into the settings
        //    page. (The selected-row checkmark svg is class "_check_", not
        //    "itemIcon", so it cannot fake the guard.)
        const menus = document.querySelectorAll('[role="menu"]');
        const glyphMenus = [];
        for (let i = 0; i < menus.length; i++) {
          if (menus[i].querySelector('span[class*="itemIcon"]') !== null) glyphMenus.push(menus[i]);
        }
        const items = document.querySelectorAll('[role="menu"] button[role="menuitem"]');
        for (let i = 0; i < items.length; i++) {
          const button = items[i];
          const text = button.textContent ? button.textContent.trim() : "";
          const menu = button.closest('[role="menu"]');
          if (text === currentLabel && menu !== null && glyphMenus.indexOf(menu) !== -1) {
            button.setAttribute(PERM_ITEM_MARKER, "");
          } else {
            button.removeAttribute(PERM_ITEM_MARKER);
          }
        }
        // 2) Composer trigger button: [triggerIcon?][triggerLabel][chevron svg];
        //    with no glyph the icon span is absent, leaving label + chevron.
        //    Skip menu rows (handled above) and the settings dialog (its nav
        //    row carries the same label but is owned by the settings-nav icon).
        const buttons = document.querySelectorAll("button");
        for (let i = 0; i < buttons.length; i++) {
          const button = buttons[i];
          if (button.getAttribute("role") === "menuitem") continue;
          if (button.closest('[role="dialog"]') !== null) continue;
          if (button.hasAttribute(SETTINGS_NAV_MARKER)) continue;
          const spans = button.querySelectorAll(":scope > span");
          let labelText = "";
          for (let j = 0; j < spans.length; j++) {
            const s = spans[j].textContent ? spans[j].textContent.trim() : "";
            if (s.length > 0) { labelText = s; break; }
          }
          const matches = labelText === currentLabel && button.querySelector("svg") !== null;
          if (matches) button.setAttribute(PERM_TRIGGER_MARKER, "");
          else button.removeAttribute(PERM_TRIGGER_MARKER);
        }
      };
      sync();
      const observer = new MutationObserver(sync);
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      return function () {
        disposed = true;
        observer.disconnect();
        const names = [PERM_ITEM_MARKER, PERM_TRIGGER_MARKER];
        for (let n = 0; n < names.length; n++) {
          const marked = document.querySelectorAll("[" + names[n] + "]");
          for (let i = 0; i < marked.length; i++) marked[i].removeAttribute(names[n]);
        }
      };
    }

    // ---- 自动审查 menu row + Jev gate visibility -----------------------------
    // Marks the agent-review preset's /permission menu row (same guarded
    // marking as the 自动审批 row) and hides it while the Jev gate is closed:
    // the review mode cannot run without the Jev judge, so offering the row
    // would only bounce the user back (the host-side gate fallback keeps them
    // safe either way). Gate snapshot comes from getState().reviewAvailable.
    const REVIEW_ITEM_MARKER = "data-dsh-agent-approval-review-item";
    const REVIEW_GATE_ATTR = "data-dsh-agent-approval-review-gate";

    function setReviewGate(available) {
      try {
        document.body.setAttribute(REVIEW_GATE_ATTR, available ? "on" : "off");
      } catch (e) {
        /* body may be unavailable during teardown */
      }
    }

    function registerReviewMenuItem(label) {
      let disposed = false;
      const sync = function () {
        if (disposed) return;
        const currentLabel = String(label).trim();
        if (currentLabel.length === 0) return;
        const menus = document.querySelectorAll('[role="menu"]');
        const glyphMenus = [];
        for (let i = 0; i < menus.length; i++) {
          if (menus[i].querySelector('span[class*="itemIcon"]') !== null) glyphMenus.push(menus[i]);
        }
        const items = document.querySelectorAll('[role="menu"] button[role="menuitem"]');
        for (let i = 0; i < items.length; i++) {
          const button = items[i];
          const text = button.textContent ? button.textContent.trim() : "";
          const menu = button.closest('[role="menu"]');
          if (text === currentLabel && menu !== null && glyphMenus.indexOf(menu) !== -1) {
            button.setAttribute(REVIEW_ITEM_MARKER, "");
          } else {
            button.removeAttribute(REVIEW_ITEM_MARKER);
          }
        }
      };
      sync();
      const observer = new MutationObserver(sync);
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      return function () {
        disposed = true;
        observer.disconnect();
        const marked = document.querySelectorAll("[" + REVIEW_ITEM_MARKER + "]");
        for (let i = 0; i < marked.length; i++) marked[i].removeAttribute(REVIEW_ITEM_MARKER);
        try {
          document.body.removeAttribute(REVIEW_GATE_ATTR);
        } catch (e) {
          /* teardown only */
        }
      };
    }

    // ---- Client Remote contribution -------------------------------------------
    // The browser-side `remote.agentApproval` service only exists after this
    // module mounts its namespace via ctx.remote.$mount(): dsh-api-remotes'
    // client assembly mounts only the official namespaces, so a plugin must
    // mount its own. Mirrors the invocations in typert.host.js (id,
    // service/namespace/method). zod is not requirable in the browser module
    // loader, so codecs use passthrough schemas. The wire contract spans two
    // host generations (v1.7.0): the client Remote registry validates
    // `codec.schema.parse` on DSH ≤ 0.1.5-rc.3 but a `codec.create()` factory
    // on 0.1.7-rc.1+ ("strict codec has no create() factory" kills the mount),
    // so every codec carries BOTH fields over the same passthrough schema.
    const passthrough = () => ({ parse: (v) => v });
    const strictCodec = (typeSymbol) => {
      const schema = passthrough();
      return { mode: "strict", typeSymbol, schema, create: () => schema };
    };
    const param = (typeSymbol) => [
      {
        name: "request",
        wire: "request",
        source: "json",
        codec: strictCodec(typeSymbol),
      },
    ];
    const result = (typeSymbol) => strictCodec(typeSymbol);
    const CLIENT_REMOTE = {
      package: "dsh-agent-approval",
      descriptors: [
        {
          id: "dsh-agent-approval#agentApproval/getState",
          service: "agentApproval",
          namespace: "agentApproval",
          method: "getState",
          invocation: { kind: "direct" },
          parameters: [],
          result: result("dsh-agent-approval#AgentApprovalStateResult"),
        },
        {
          id: "dsh-agent-approval#agentApproval/setModel",
          service: "agentApproval",
          namespace: "agentApproval",
          method: "setModel",
          invocation: { kind: "direct" },
          parameters: param("dsh-agent-approval#AgentApprovalSetModelRequest"),
          result: result("dsh-agent-approval#AgentApprovalSetModelResult"),
        },
        {
          id: "dsh-agent-approval#agentApproval/setJudgeMode",
          service: "agentApproval",
          namespace: "agentApproval",
          method: "setJudgeMode",
          invocation: { kind: "direct" },
          parameters: param("dsh-agent-approval#AgentApprovalSetJudgeModeRequest"),
          result: result("dsh-agent-approval#AgentApprovalSetJudgeModeResult"),
        },
        {
          id: "dsh-agent-approval#agentApproval/setReviewDefault",
          service: "agentApproval",
          namespace: "agentApproval",
          method: "setReviewDefault",
          invocation: { kind: "direct" },
          parameters: param("dsh-agent-approval#AgentApprovalSetReviewDefaultRequest"),
          result: result("dsh-agent-approval#AgentApprovalSetReviewDefaultResult"),
        },
        {
          id: "dsh-agent-approval#agentApproval/setJevConfig",
          service: "agentApproval",
          namespace: "agentApproval",
          method: "setJevConfig",
          invocation: { kind: "direct" },
          parameters: param("dsh-agent-approval#AgentApprovalSetJevRequest"),
          result: result("dsh-agent-approval#AgentApprovalSetJevResult"),
        },
        {
          id: "dsh-agent-approval#agentApproval/setApprovalTimeout",
          service: "agentApproval",
          namespace: "agentApproval",
          method: "setApprovalTimeout",
          invocation: { kind: "direct" },
          parameters: param("dsh-agent-approval#AgentApprovalSetTimeoutRequest"),
          result: result("dsh-agent-approval#AgentApprovalSetTimeoutResult"),
        },
        {
          id: "dsh-agent-approval#agentApproval/toggle",
          service: "agentApproval",
          namespace: "agentApproval",
          method: "toggle",
          invocation: { kind: "direct" },
          parameters: param("dsh-agent-approval#AgentApprovalToggleRequest"),
          result: result("dsh-agent-approval#AgentApprovalToggleResult"),
        },
        {
          id: "dsh-agent-approval#agentApproval/addRule",
          service: "agentApproval",
          namespace: "agentApproval",
          method: "addRule",
          invocation: { kind: "direct" },
          parameters: param("dsh-agent-approval#AgentApprovalAddRuleRequest"),
          result: result("dsh-agent-approval#AgentApprovalRulesResult"),
        },
        {
          id: "dsh-agent-approval#agentApproval/removeRule",
          service: "agentApproval",
          namespace: "agentApproval",
          method: "removeRule",
          invocation: { kind: "direct" },
          parameters: param("dsh-agent-approval#AgentApprovalRemoveRuleRequest"),
          result: result("dsh-agent-approval#AgentApprovalRulesResult"),
        },
        {
          id: "dsh-agent-approval#agentApproval/sessionRecords",
          service: "agentApproval",
          namespace: "agentApproval",
          method: "sessionRecords",
          invocation: { kind: "direct" },
          parameters: param("dsh-agent-approval#AgentApprovalSessionRecordsRequest"),
          result: result("dsh-agent-approval#AgentApprovalSessionRecordsResult"),
        },
        {
          id: "dsh-agent-approval#agentApproval/directory",
          service: "agentApproval",
          namespace: "agentApproval",
          method: "directory",
          invocation: { kind: "direct" },
          parameters: [],
          result: result("dsh-agent-approval#AgentApprovalDirectoryResult"),
        },
      ],
    };

    async function apply(ctx) {
      // Mount the agentApproval namespace before anything touches it; the
      // mount's lifetime is bound to this plugin's context by $mount itself.
      await ctx.remote.$mount(CLIENT_REMOTE);

      const styleTag = document.createElement("style");
      styleTag.textContent = CSS;
      document.head.appendChild(styleTag);
      ctx.effect(() => () => styleTag.remove());

      // Mark our settings-nav row so the CSS above replaces the shell's
      // fallback gear (no icon field exists in settings.section yet).
      ctx.effect(() => registerSettingsNavIcon(SETTINGS_LABEL));

      // Mark the /permission menu row and the composer trigger button so the
      // CSS above paints the preset glyph (external presets get no icon from
      // the official permissionGlyphs map; no public registration seam).
      ctx.effect(() => registerPermissionGlyphIcon(SETTINGS_LABEL));

      // Mark the 自动审查 menu row (same glyph-set guard) and hide it while
      // the Jev gate is closed; the same snapshot feeds the Settings card.
      ctx.effect(() => registerReviewMenuItem(REVIEW_LABEL));

      // ctx.get() reads the service without the property-accessor inject guard.
      const remote = ctx.get("remote.agentApproval");

      // Jev gate snapshot (also flips the 自动审查 menu row's visibility).
      // Guarded: a degraded/old remote surface fails the gate closed.
      if (remote && typeof remote.getState === "function") {
        remote
          .getState()
          .then((res) => {
            const s = pick(res);
            setReviewGate(s.reviewAvailable === true);
          })
          .catch(() => setReviewGate(false));
      } else {
        setReviewGate(false);
      }

      // ---- helpers -----------------------------------------------------------

      /**
       * The Remote gateway returns `res.value` = the Host method's full
       * `{ ok, value }` envelope; unwrap it (tolerate both shapes) and surface
       * either error layer.
       */
      function pick(res) {
        if (res && res.ok === false) {
          const err = res.error || {};
          throw new Error(err.message || err.code || "request failed");
        }
        const v = res && res.value;
        if (v && typeof v === "object" && v.ok === false) {
          const err = v.error || {};
          throw new Error(err.message || err.code || "request failed");
        }
        if (v && typeof v === "object" && v.ok === true) return v.value;
        return v;
      }

      const h = React.createElement;
      const OUTCOME_LABEL = {
        "allowed-once": "✅ 批准",
        rejected: "⛔ 拒绝",
        cancelled: "⚡ 已取消",
        unavailable: "⛔ 失败未放行",
      };
      const RISK_LABEL = { low: "低", medium: "中", high: "高" };

      function truncText(s, n) {
        return typeof s === "string" && s.length > n ? s.slice(0, n) + "…" : s || "";
      }

      /**
        Mirror of Host `shortId()`: DSH prefixes session ids with the literal
        `"session-"` before the UUID, so a naive `slice(0, 8)` shows nothing
        but `"session-"`. Strip the known prefix so the chip displays 8 chars
        of the UUID proper. Kept here too because the bundle has no shared
        module with the Host half.
      */
      function shortSessionId(id) {
        const s = String(id);
        const tail = s.indexOf("session-") === 0 ? s.slice("session-".length) : s;
        return tail.slice(0, 8);
      }

      function fmtTime(iso) {
        try {
          const d = new Date(iso);
          const p = (v) => String(v).padStart(2, "0");
          return (
            p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds())
          );
        } catch (e) {
          return String(iso);
        }
      }

      // NOTE: no composer chip anymore. The mode lives in the /permission
      // menu as the "自动审批" preset (same place users switch Read-only /
      // Workspace Write / Full access); a second toggle beside that menu was
      // redundant. Enabling surfaces: the menu, the /agent-approval command,
      // and this Settings page (whose session chips can also disable one).

      // ---- settings page (settings.section) -----------------------------------

      function AgentApprovalSection(props) {
        const stateSlot = React.useState(null);
        const setState = stateSlot[1];
        const dirSlot = React.useState(null);
        const setDir = dirSlot[1];
        const providerSlot = React.useState("");
        const setProvider = providerSlot[1];
        const modelSlot = React.useState("");
        const setModel = modelSlot[1];
        // Judge invocation mode (v1.8.0): "llm" (default, one direct stream
        // call — no subagent session) / "subagent" (isolated judge child).
        const judgeModeSlot = React.useState("llm");
        const judgeMode = judgeModeSlot[0];
        const setJudgeMode = judgeModeSlot[1];
        // v1.8.0: global default — fresh sessions auto-enter 自动审查
        // (Jev-gated); shown as the 逐调用审查 switch when Provider = Jev.
        const reviewDefaultSlot = React.useState(false);
        const reviewDefault = reviewDefaultSlot[0];
        const setReviewDefault = reviewDefaultSlot[1];
        const timeoutSlot = React.useState("");
        const setTimeoutDraft = timeoutSlot[1];
        // Jev backend drafts (edited in the Jev card shown when the judge
        // provider is the synthetic "typesafe" entry).
        const jevKeySlot = React.useState("");
        const setJevKey = jevKeySlot[1];
        const jevEndpointSlot = React.useState("");
        const setJevEndpoint = jevEndpointSlot[1];
        const jevModelSlot = React.useState("");
        const setJevModel = jevModelSlot[1];
        const jevConfSlot = React.useState("0.5");
        const setJevConf = jevConfSlot[1];
        const noteSlot = React.useState("");
        const note = noteSlot[0];
        const setNote = noteSlot[1];
        // Rule-add form drafts (the table itself comes from getState).
        const ruleEffectSlot = React.useState("allow");
        const ruleToolSlot = React.useState("");
        const ruleMatchSlot = React.useState("");
        const ruleNoteSlot = React.useState("");

        const refresh = () => {
          remote
            .getState()
            .then((res) => {
              const s = pick(res);
              setState(s);
              setProvider(s.model.provider);
              setModel(s.model.model);
              // A not-yet-restarted old host sends no `judgeMode` — default.
              setJudgeMode(s.judgeMode === "subagent" ? "subagent" : "llm");
              // Gate snapshot also hides/shows the 自动审查 menu row.
              setReviewGate(s.reviewAvailable === true);
              // A not-yet-restarted old host sends no `reviewDefault` — off.
              setReviewDefault(s.reviewDefault === true);
              setTimeoutDraft(String(s.timeoutMs));
              // A not-yet-restarted old host sends no `jev` field — keep drafts.
              setJevKey(s.jev && typeof s.jev.apiKey === "string" ? s.jev.apiKey : "");
              setJevEndpoint(s.jev && typeof s.jev.endpoint === "string" ? s.jev.endpoint : "");
              setJevModel(s.jev && typeof s.jev.model === "string" ? s.jev.model : "");
              setJevConf(s.jev && typeof s.jev.confidence === "number" ? String(s.jev.confidence) : "0.5");
            })
            .catch((e) => setNote("无法读取状态：" + (e && e.message ? e.message : String(e))));
        };

        React.useEffect(() => {
          refresh();
          remote
            .directory()
            .then((res) => setDir(pick(res)))
            .catch(() => setDir({ providers: [], models: [], defaultSelection: null }));
        }, []);

        const state = stateSlot[0];
        const dir = dirSlot[0];
        const provider = providerSlot[0];
        const model = modelSlot[0];
        const timeoutDraft = timeoutSlot[0];

        const saveModel = () => {
          remote
            .setModel({ provider: provider, model: model })
            .then(() => {
              refresh();
              setNote("审批模型已保存");
            })
            .catch((e) => setNote("保存失败：" + (e && e.message ? e.message : String(e))));
        };
        const saveJudgeMode = (mode) => {
          if (typeof remote.setJudgeMode !== "function") {
            setNote("Host 半未更新（缺少 setJudgeMode）：请重装本插件并重启 DSH。");
            return;
          }
          remote
            .setJudgeMode({ mode: mode })
            .then(() => {
              setJudgeMode(mode);
              setNote(
                mode === "subagent"
                  ? "裁决方式已保存：隔离子代理（每次裁决创建一个审批子会话）"
                  : "裁决方式已保存：LLM 直连（不创建子会话，零上下文污染）",
              );
            })
            .catch((e) => setNote("保存失败：" + (e && e.message ? e.message : String(e))));
        };
        const saveReviewDefault = (on) => {
          if (typeof remote.setReviewDefault !== "function") {
            setNote("Host 半未更新（缺少 setReviewDefault）：请重装本插件并重启 DSH。");
            return;
          }
          remote
            .setReviewDefault({ on: on })
            .then(() => {
              setReviewDefault(on);
              setNote(
                on
                  ? "逐调用审查已开启：新开会话自动进入自动审查（Jev 判定每个工具调用）"
                  : "逐调用审查已关闭：新会话按默认预设开启",
              );
            })
            .catch((e) => setNote("保存失败：" + (e && e.message ? e.message : String(e))));
        };
        const jevKey = jevKeySlot[0];
        const jevEndpoint = jevEndpointSlot[0];
        const jevModel = jevModelSlot[0];
        const jevConf = jevConfSlot[0];
        const saveJev = () => {
          if (typeof remote.setJevConfig !== "function") {
            setNote("Host 半未更新（缺少 setJevConfig）：请重装本插件并重启 DSH。");
            return;
          }
          const conf = Number(jevConf);
          if (!Number.isFinite(conf) || conf <= 0 || conf >= 1) {
            setNote("置信度阈值必须是 0–1 之间的小数（如 0.5）");
            return;
          }
          remote
            .setJevConfig({ apiKey: jevKey, endpoint: jevEndpoint, model: jevModel, confidence: conf })
            .then(() => {
              refresh();
              setNote("Jev 配置已保存");
            })
            .catch((e) => setNote("保存失败：" + (e && e.message ? e.message : String(e))));
        };
        const saveTimeout = () => {
          const parsed = Number(timeoutDraft);
          if (!Number.isFinite(parsed)) {
            setNote("超时必须是数字（毫秒）");
            return;
          }
          remote
            .setApprovalTimeout({ timeoutMs: parsed })
            .then((res) => {
              const v = pick(res);
              setTimeoutDraft(String(v.timeoutMs));
              setNote("审批超时已保存");
            })
            .catch((e) => setNote("保存失败：" + (e && e.message ? e.message : String(e))));
        };
        const disableSession = (sid) => {
          remote
            .toggle({ sessionId: sid, on: false })
            .then(refresh)
            .catch(() => {});
        };

        const ruleEffect = ruleEffectSlot[0];
        const ruleTool = ruleToolSlot[0];
        const ruleMatch = ruleMatchSlot[0];
        const ruleNote = ruleNoteSlot[0];
        const setRuleEffect = ruleEffectSlot[1];
        const setRuleTool = ruleToolSlot[1];
        const setRuleMatch = ruleMatchSlot[1];
        const setRuleNote = ruleNoteSlot[1];
        const rules = state !== null && Array.isArray(state.rules) ? state.rules : [];

        const addRule = (draft) => {
          remote
            .addRule(draft)
            .then((res) => {
              const v = pick(res);
              setState((prev) => (prev ? Object.assign({}, prev, { rules: v.rules }) : prev));
              setRuleTool("");
              setRuleMatch("");
              setRuleNote("");
              setNote("规则已保存（deny 优先于 allow；命中即不再经过审批模型）");
            })
            .catch((e) => setNote("保存失败：" + (e && e.message ? e.message : String(e))));
        };
        const submitRule = () => {
          if (ruleTool.trim() === "") {
            setNote("工具名必填（* 匹配所有工具）");
            return;
          }
          addRule({ effect: ruleEffect, tool: ruleTool.trim(), match: ruleMatch, note: ruleNote.trim() });
        };
        const removeRule = (id) => {
          remote
            .removeRule({ id: id })
            .then((res) => {
              const v = pick(res);
              setState((prev) => (prev ? Object.assign({}, prev, { rules: v.rules }) : prev));
            })
            .catch(() => {});
        };

        // The synthetic "typesafe" provider routes judging through the
        // TypeSafe Jev HTTP API — it is not part of the harness directory.
        const providerOptions = [{ id: "", name: "默认（Harness 默认模型）" }].concat(
          [{ id: "typesafe", name: "TypeSafe Jev（决策模型·直连 API）" }],
          dir ? dir.providers : [],
        );
        const modelOptions =
          provider === "typesafe"
            ? [
                { provider: "typesafe", id: "jev-latest", name: "jev-latest（跟随最新版本）" },
                { provider: "typesafe", id: "jev-1.13.0", name: "jev-1.13.0（锁定版本）" },
              ]
            : [{ provider: "", id: "", name: "默认（Harness 默认模型）" }].concat(
                dir && dir.models ? dir.models.filter((m) => m.provider === provider) : [],
              );
        const defaultHint =
          provider === "typesafe"
            ? "当前审批判定直连 TypeSafe Jev API，不经过 Harness 模型路由；下方 Jev 配置在该模式下生效。"
            : dir && dir.defaultSelection
              ? "未配置时使用 Harness 默认模型；当前默认路由：" +
                dir.defaultSelection.provider +
                " / " +
                dir.defaultSelection.model
              : "未配置时使用 Harness 默认模型路由";

        return h(
          "div",
          { className: "aapr-page" },
          h(
            "div",
            { className: "aapr-card" },
            h("h3", null, "自动审批权限"),
            h(
              "div",
              { className: "aapr-muted" },
              "一种新的权限模式：以 workspace-write 为基线沙箱；当工具请求提权（更宽的沙箱）时，由一个独立的审批 Agent 评估风险——安全、可逆、与任务相符的操作自动批准，破坏性、不可逆、越界或理由不符的操作直接拒绝。",
              h("br", null),
              "在输入框 /permission 菜单选择「自动审批」预设，或执行命令 /agent-approval on|off 为会话开启；每个会话的审批审计记录在该会话窗口顶部的「审批」标签页（轨迹旁），随会话保存。",
            ),
            note !== "" ? h("div", { className: "aapr-muted" }, note) : null,
          ),
          h(
            "div",
            { className: "aapr-card" },
            h("h3", null, "审批模型"),
            h(
              "div",
              { className: "aapr-row" },
              h(
                "label",
                null,
                "Provider：",
                h(
                  "select",
                  {
                    className: "aapr-select",
                    value: provider,
                    onChange: (e) => {
                      setProvider(e.target.value);
                      setModel(e.target.value === "typesafe" ? "jev-latest" : "");
                    },
                  },
                  providerOptions.map((p) =>
                    h("option", { key: p.id, value: p.id }, p.id === "" ? p.name : p.name + "（" + p.id + "）"),
                  ),
                ),
              ),
              h(
                "label",
                null,
                "Model：",
                h(
                  "select",
                  {
                    className: "aapr-select",
                    value: model,
                    onChange: (e) => setModel(e.target.value),
                    disabled: dir === null && provider !== "typesafe",
                  },
                  modelOptions.map((m) =>
                    h("option", { key: m.provider + "/" + m.id, value: m.id }, m.id === "" ? m.name : m.name + "（" + m.id + "）"),
                  ),
                ),
              ),
              h(ui.Button, { variant: "primary", size: "sm", onClick: saveModel }, "保存"),
            ),
            h("div", { className: "aapr-muted" }, defaultHint),
            provider !== "typesafe"
              ? h(
                  "div",
                  { className: "aapr-row" },
                  h(
                    "label",
                    null,
                    "裁决方式：",
                    h(
                      "select",
                      {
                        className: "aapr-select",
                        value: judgeMode,
                        onChange: (e) => saveJudgeMode(e.target.value),
                      },
                      h("option", { value: "llm" }, "LLM 直连（默认，不创建子会话）"),
                      h("option", { value: "subagent" }, "隔离子代理（legacy，创建审批子会话）"),
                    ),
                  ),
                )
              : null,
            provider !== "typesafe"
              ? h(
                  "div",
                  { className: "aapr-muted" },
                  "LLM 直连与隔离子代理是同一套审批人格、提示词与裁决格式（{decision, riskLevel, rationale}），仅调用方式不同：前者一次直连模型调用完成裁决、不启动审批子代理（零上下文污染）；后者每次裁决创建一个独立子会话（v1.8.0 前的唯一行为）。TypeSafe Jev 后端不受此设置影响。",
                )
              : null,
          ),
          provider === "typesafe"
            ? h(
                "div",
                { className: "aapr-card" },
                h("h3", null, "TypeSafe Jev 配置"),
                h(
                  "div",
                  { className: "aapr-muted" },
                  "Jev 是结构化决策模型（System One）：审批时直连 TypeSafe API，不创建审批子会话，毫秒级返回带校准概率的裁决。审计「理由」由概率分布合成（Jev 本身不生成文字）；置信度低于阈值时按 fail-closed 处理（记 unavailable，不批准也不记拒绝）。对中文任务上下文的准确率略低于英语。API Key 明文保存在本机 config.json；留空时使用环境变量 TYPESAFE_API_KEY。",
                ),
                h(
                  "div",
                  { className: "aapr-row" },
                  h(
                    "label",
                    null,
                    "API Key：",
                    h("input", {
                      className: "aapr-input",
                      type: "password",
                      placeholder: "TYPESAFE_API_KEY",
                      value: jevKey,
                      onChange: (e) => setJevKey(e.target.value),
                    }),
                  ),
                  h(
                    "label",
                    null,
                    "模型：",
                    h("input", {
                      className: "aapr-input",
                      placeholder: "jev-latest",
                      value: jevModel,
                      onChange: (e) => setJevModel(e.target.value),
                    }),
                  ),
                ),
                h(
                  "div",
                  { className: "aapr-row" },
                  h(
                    "label",
                    null,
                    "Endpoint：",
                    h("input", {
                      className: "aapr-input aapr-input-wide",
                      placeholder: "https://api.typesafe.ai/v1/systemone",
                      value: jevEndpoint,
                      onChange: (e) => setJevEndpoint(e.target.value),
                    }),
                  ),
                  h(
                    "label",
                    null,
                    "置信度阈值：",
                    h("input", {
                      className: "aapr-input",
                      type: "number",
                      step: "0.05",
                      min: "0.01",
                      max: "0.99",
                      value: jevConf,
                      onChange: (e) => setJevConf(e.target.value),
                    }),
                  ),
                  h(ui.Button, { variant: "primary", size: "sm", onClick: saveJev }, "保存"),
                ),
              )
            : null,
          provider === "typesafe"
            ? h(
                "div",
                { className: "aapr-card" },
                h("h3", null, "自动审查（逐调用审查）"),
                h(
                  "div",
                  { className: "aapr-row" },
                  h(
                    "label",
                    null,
                    "逐调用审查：",
                    h(
                      "select",
                      {
                        className: "aapr-select",
                        value: reviewDefault ? "on" : "off",
                        disabled: state !== null && state.reviewAvailable !== true,
                        onChange: (e) => saveReviewDefault(e.target.value === "on"),
                      },
                      h("option", { value: "on" }, "开（新会话自动审查每个工具调用）"),
                      h("option", { value: "off" }, "关（新会话按默认预设）"),
                    ),
                  ),
                ),
                h(
                  "div",
                  { className: "aapr-muted" },
                  "开启后，新开会话自动进入自动审查：以 danger-full-access 为基线，每个工具调用（含 PTC 内层调用，外层 run_code 传输除外）执行前经 Jev 判定一次——风险调用直接拒绝、body 不执行、不转人工（fail-closed，拒绝即最终结论）。规则表与会话内信任缓存先行短路降噪；命中拒绝规则、Jev 判拒、低置信、超时、网络故障一律拒绝该调用（工具卡片显示 AGENT_REVIEW_DENIED 详情与风险理由）。",
                  h("br", null),
                  "已存在的会话不受此开关影响，可用 /permission 菜单「自动审查」或 /agent-review on|off 单独切换。审计逐调用记录在「审批」标签页（工具列标注「逐调用」）。",
                  h("br", null),
                  state === null
                    ? "状态加载中…"
                    : state.reviewAvailable === true
                      ? "当前状态：Jev 判定可用。"
                      : "当前状态：Jev 判定不可用（缺 API Key），开关已禁用，新会话不会自动审查。",
                ),
              )
            : null,
          h(
            "div",
            { className: "aapr-card" },
            h("h3", null, "审批超时"),
            h(
              "div",
              { className: "aapr-row" },
              h("input", {
                className: "aapr-input",
                type: "number",
                value: timeoutDraft,
                onChange: (e) => setTimeoutDraft(e.target.value),
              }),
              h("span", { className: "aapr-muted" }, "毫秒（30000–600000，超时按拒绝处理，fail-closed）"),
              h(ui.Button, { variant: "primary", size: "sm", onClick: saveTimeout }, "保存"),
            ),
          ),
          h(
            "div",
            { className: "aapr-card" },
            h("h3", null, "已开启的会话"),
            state === null
              ? h("div", { className: "aapr-muted" }, "加载中…")
              : state.enabledSessions.length === 0
                ? h("div", { className: "aapr-muted" }, "当前没有会话开启自动审批/自动审查。")
                : h(
                    "div",
                    { className: "aapr-row" },
                    state.enabledSessions.map((raw) => {
                      // New hosts send { id, title, cwd }; a not-yet-restarted
                      // old host still sends bare id strings — render both.
                      const info =
                        typeof raw === "string" ? { id: raw, title: "", cwd: "" } : raw;
                      const sid = String(info.id);
                      const title =
                        typeof info.title === "string" && info.title !== "" ? info.title : "";
                      const cwd = typeof info.cwd === "string" && info.cwd !== "" ? info.cwd : "";
                      const tip =
                        "会话 ID：" + sid + (cwd !== "" ? "\n工作区：" + cwd : "");
                      const sidShort = shortSessionId(sid);
                      return h(
                        "span",
                        { key: sid, className: "aapr-chip", title: tip },
                        h(
                          "span",
                          { className: "aapr-chip-title" },
                          title !== "" ? title : sidShort,
                        ),
                        title !== ""
                          ? h("span", { className: "aapr-chip-id" }, sidShort)
                          : null,
                        h(
                          "button",
                          { onClick: () => disableSession(sid), title: "关闭该会话的自动审批/自动审查" },
                          "✕",
                        ),
                      );
                    }),
                  ),
          ),
          h(
            "div",
            { className: "aapr-card" },
            h("h3", null, "放行 / 拒绝规则"),
            h(
              "div",
              { className: "aapr-muted" },
              "命中规则的提权不再经过审批模型：拒绝规则直接拒、放行规则直接过（拒绝优先于放行）。match 留空 = 该工具全部调用；否则是参数 JSON 的子串，或 /正则/flags 形式。另：模型批准后，同一会话内参数完全相同的再次提权直接放行（会话内信任，不跨会话、不泛化）。",
            ),
            rules.length === 0
              ? h("div", { className: "aapr-muted" }, "暂无规则。")
              : rules.map((rule) =>
                  h(
                    "div",
                    { key: rule.id, className: "aapr-row" },
                    h(
                      "span",
                      { className: rule.effect === "allow" ? "aapr-ok" : "aapr-no" },
                      rule.effect === "allow" ? "放行" : "拒绝",
                    ),
                    h("span", { className: "aapr-chip-id" }, String(rule.tool)),
                    rule.match !== ""
                      ? h("span", { className: "aapr-rule-match", title: String(rule.match) }, truncText(rule.match, 60))
                      : h("span", { className: "aapr-muted" }, "（全部调用）"),
                    rule.note !== ""
                      ? h("span", { className: "aapr-muted" }, truncText(rule.note, 40))
                      : null,
                    h("button", { className: "aapr-rule-del", onClick: () => removeRule(rule.id), title: "删除该规则" }, "✕"),
                  ),
                ),
            h(
              "div",
              { className: "aapr-row" },
              h(
                "select",
                { className: "aapr-select", value: ruleEffect, onChange: (e) => setRuleEffect(e.target.value) },
                h("option", { value: "allow" }, "放行"),
                h("option", { value: "deny" }, "拒绝"),
              ),
              h("input", { className: "aapr-input", placeholder: "工具名（* = 所有工具）", value: ruleTool, onChange: (e) => setRuleTool(e.target.value) }),
              h("input", { className: "aapr-input aapr-input-wide", placeholder: "match：留空 = 全部；子串或 /正则/flags", value: ruleMatch, onChange: (e) => setRuleMatch(e.target.value) }),
              h("input", { className: "aapr-input", placeholder: "备注（可选）", value: ruleNote, onChange: (e) => setRuleNote(e.target.value) }),
              h(ui.Button, { variant: "primary", size: "sm", onClick: submitRule }, "添加"),
            ),
          ),
        );
      }

      /**
       * The conversation-window「审批」tab (`conversation.view`, next to
       * 轨迹): this session's audit trail, folded by the Host out of the
       * session's own sidecar storage. Rendered only while the tab is
       * active, so the 10s poll costs nothing otherwise. Session-scoped
       * slot: the runtime hands us the standard `useSession` hook; the
       * snapshot's `sessionId` leaf is the only field we read.
       */
      function ApprovalAuditView(props) {
        const useSession = props.useSession;
        const session = useSession(function (s) { return s; });
        const sessionId = session && session.sessionId ? String(session.sessionId) : "";

        const stateSlot = React.useState(null); // { records, enabled } | null
        const state = stateSlot[0];
        const setState = stateSlot[1];
        const noteSlot = React.useState("");
        const note = noteSlot[0];
        const setNote = noteSlot[1];
        const tickSlot = React.useState(0); // manual-refresh counter
        const tick = tickSlot[0];
        const setTick = tickSlot[1];

        React.useEffect(() => {
          if (sessionId === "") return undefined;
          let alive = true;
          const load = () => {
            if (typeof remote.sessionRecords !== "function") {
              if (alive) setNote("Host 半未更新（缺少 sessionRecords）：请重装本插件并重启 DSH。");
              return;
            }
            remote
              .sessionRecords({ sessionId: sessionId })
              .then((res) => {
                if (alive) setState(pick(res));
              })
              .catch((e) => {
                if (alive) setNote("无法读取审批记录：" + (e && e.message ? e.message : String(e)));
              });
          };
          load();
          const timer = setInterval(load, 10000);
          return () => {
            alive = false;
            clearInterval(timer);
          };
        }, [sessionId, tick]);

        // One-click whitelist from an audit row: the recorded args are a
        // PREFIX of the real arguments JSON (the Host truncates at 2000
        // chars), so stripping the truncation marker keeps a valid substring.
        const whitelistRecord = (r) => {
          const args = String(r.args || "").replace(/…\[truncated\]$/, "");
          remote
            .addRule({
              effect: "allow",
              tool: String(r.toolName),
              match: args,
              note: "来自审批审计 " + fmtTime(r.at),
            })
            .then(() => setNote("已加白：今后该操作直接放行，不再经过审批模型。"))
            .catch((e) => setNote("加白失败：" + (e && e.message ? e.message : String(e))));
        };

        const records = state !== null && Array.isArray(state.records) ? state.records : [];
        // 倒序展示（最新在最上）；Host 仍按时间正序返回，顺序属于视图层。
        const ordered = records.slice().reverse();
        const enabled = state !== null ? !!state.enabled : null;

        return h(
          "div",
          { className: "aapr-view" },
          h(
            "div",
            { className: "aapr-view-inner" },
            h(
              "div",
              { className: "aapr-view-head" },
              h("h3", { className: "aapr-view-title" }, "审批审计（本会话）"),
              enabled === true
                ? h("span", { className: "aapr-state-on" }, "● 自动审批/自动审查已开启")
                : enabled === false
                  ? h("span", { className: "aapr-state-off" }, "○ 自动审批/自动审查未开启")
                  : null,
              h(ui.Button, { variant: "ghost", size: "sm", onClick: () => setTick(tick + 1) }, "刷新"),
              note !== "" ? h("span", { className: "aapr-muted" }, note) : null,
            ),
            h(
              "div",
              { className: "aapr-muted" },
              "审批结论随会话保存（会话目录内的独立记录文件）：随会话恢复，删除会话即随之删除，最新记录在最上。悬停「审批理由」可查看完整理由与工具参数；「审批会话」前缀可在会话列表中找到审批 Agent 的完整会话记录。",
            ),
            sessionId === ""
              ? h("div", { className: "aapr-muted" }, "当前没有活动会话。")
              : records.length === 0
                ? h("div", { className: "aapr-muted" }, "本会话暂无审批记录。")
                : h(
                    "div",
                    { className: "aapr-wrap" },
                    h(
                      "table",
                      { className: "aapr-table" },
                      h(
                        "thead",
                        null,
                        h(
                          "tr",
                          null,
                          ["时间", "工具", "结果", "风险", "模型", "耗时", "审批理由", "规则"].map((t) => h("th", { key: t }, t)),
                        ),
                      ),
                      h(
                        "tbody",
                        null,
                        ordered.map((r, i) =>
                          h(
                            "tr",
                            { key: String(r.at) + "-" + String(i) },
                            h("td", null, fmtTime(r.at)),
                            h(
                              "td",
                              null,
                              String(r.toolName),
                              r.mode === "review" ? h("span", { className: "aapr-mode-review" }, "逐调用") : null,
                            ),
                            h("td", { className: r.outcome === "allowed-once" ? "aapr-ok" : "aapr-no" }, OUTCOME_LABEL[r.outcome] || String(r.outcome)),
                            h("td", null, RISK_LABEL[r.riskLevel] || String(r.riskLevel || "-")),
                            h("td", null, String(r.model)),
                            h("td", null, String(r.durationMs) + "ms"),
                            h(
                              "td",
                              {
                                className: "aapr-cell",
                                title:
                                  (r.rationale || "") +
                                  (r.args ? "\n\n工具参数：" + r.args : "") +
                                  (r.childSessionId ? "\n\n审批会话：" + r.childSessionId : ""),
                              },
                              truncText(r.rationale, 110),
                            ),
                            h(
                              "td",
                              null,
                              r.outcome === "allowed-once" && r.args && r.model !== "rule"
                                ? h(
                                    "button",
                                    {
                                      className: "aapr-whitelist",
                                      onClick: () => whitelistRecord(r),
                                      title: "把该操作存为放行规则（工具 + 参数子串）：今后直接放行，不再经过审批模型",
                                    },
                                    "加白",
                                  )
                                : null,
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
          ),
        );
      }

      // Settings entry: a full page under the sidebar Settings panel.
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          { name: "settings.section", id: "agent-approval", order: 30, label: () => SETTINGS_LABEL },
          AgentApprovalSection,
        ),
      );

      // Conversation entry: the「审批」audit tab in the view ring, right
      // beside 轨迹 (chat order 0, trajectory order 10, audit order 11).
      // Session-scoped: renders per conversation with the session's own
      // records; registration rides the slot ledger so plugin unload
      // removes the tab.
      ctx.slots.inject("conversation.view", () =>
        ctx.slots.register(
          { name: "conversation.view", id: "agent-approval-audit", order: 11, label: () => "审批" },
          ApprovalAuditView,
        ),
      );
    }

    exports.apply = apply;
    exports.inject = ["slots", "remote"];
    return module.exports;
  },
});
