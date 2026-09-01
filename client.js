/**
 * dsh-agent-approval — Client half (web bundle).
 *
 * Rendered by the DSH web shell via `window.__ModuleLoader__.load`. Adds:
 *
 *   1. A "Agent 审批" page in the Settings panel (`settings.section`):
 *      - approval model picker (provider + model, or the harness default),
 *      - judge timeout setting (fail-closed),
 *      - the list of sessions with the mode enabled (session-list title +
 *        workspace, so each chip is recognizable),
 *      - the latest approval audit records (verdict, risk, model, duration,
 *        rationale; hover for the full rationale + tool arguments).
 *
 * Session-level on/off lives in the /permission menu (the "Agent 审批"
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
   (sibling rows carry span._itemIcon_*) qualify — the composer /permission
   menu does; the settings PermissionRow dropdown (settings.general 权限 row,
   portaled to <body>) renders NO icons for any preset, so an icon there
   would be an uninvited extra and is deliberately left unmarked. */
[data-dsh-agent-approval-perm-item]::before,
[data-dsh-agent-approval-perm-trigger]::before{content:'';flex:none;width:16px;height:16px;background:currentColor;-webkit-mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 16 16' fill='none'%3E%3Cpath d='M8.20554 0.899994L14.7901 3.36857V7.01026C14.7901 12 11.0466 14.2103 8.20554 15.3C5.36446 14.2103 1.62012 12 1.62012 7.01026V3.36857L8.20554 0.899994Z' stroke='black' stroke-width='1.31831' stroke-linejoin='round'/%3E%3Cpath d='M8 3.2L9.1 5.9L11.8 7L9.1 8.1L8 10.8L6.9 8.1L4.2 7L6.9 5.9Z' fill='black'/%3E%3C/svg%3E") center/contain no-repeat;mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 16 16' fill='none'%3E%3Cpath d='M8.20554 0.899994L14.7901 3.36857V7.01026C14.7901 12 11.0466 14.2103 8.20554 15.3C5.36446 14.2103 1.62012 12 1.62012 7.01026V3.36857L8.20554 0.899994Z' stroke='black' stroke-width='1.31831' stroke-linejoin='round'/%3E%3Cpath d='M8 3.2L9.1 5.9L11.8 7L9.1 8.1L8 10.8L6.9 8.1L4.2 7L6.9 5.9Z' fill='black'/%3E%3C/svg%3E") center/contain no-repeat}
`;

    // ---- Settings nav icon --------------------------------------------------
    // DSH 0.1.x does not yet carry an icon through the settings.section
    // registration contract: its shell projects only id/order/label and
    // paints a generic gear for every external section. Mark only this
    // plugin's localized nav row so the CSS above can replace the fallback
    // gear; the disposer clears the marker for HMR / plugin disable.
    const SETTINGS_LABEL = "Agent 审批";
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
        //    span[class*="_itemIcon_"] — the CSS-modules build keeps the source
        //    class name as a substring). The composer /permission menu
        //    qualifies; the settings PermissionRow dropdown (portaled to
        //    <body>, no item icons for any preset) does NOT, so the glyph no
        //    longer leaks into the settings page. (The selected-row checkmark
        //    svg is class "_check_", not "_itemIcon_", so it cannot fake the
        //    guard.)
        const menus = document.querySelectorAll('[role="menu"]');
        const glyphMenus = [];
        for (let i = 0; i < menus.length; i++) {
          if (menus[i].querySelector('span[class*="_itemIcon_"]') !== null) glyphMenus.push(menus[i]);
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

    // ---- Client Remote contribution -------------------------------------------
    // The browser-side `remote.agentApproval` service only exists after this
    // module mounts its namespace via ctx.remote.$mount(): dsh-api-remotes'
    // client assembly mounts only the official namespaces, so a plugin must
    // mount its own. Mirrors the invocations in typert.host.js (id,
    // service/namespace/method). zod is not requirable in the browser module
    // loader, so codecs use passthrough schemas — the runtime contract only
    // requires typeSymbol + schema.parse().
    const passthrough = () => ({ parse: (v) => v });
    const param = (typeSymbol) => [
      {
        name: "request",
        wire: "request",
        source: "json",
        codec: { mode: "strict", typeSymbol, schema: passthrough() },
      },
    ];
    const result = (typeSymbol) => ({
      mode: "strict",
      typeSymbol,
      schema: passthrough(),
    });
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
          id: "dsh-agent-approval#agentApproval/clearRecords",
          service: "agentApproval",
          namespace: "agentApproval",
          method: "clearRecords",
          invocation: { kind: "direct" },
          parameters: [],
          result: result("dsh-agent-approval#AgentApprovalClearRecordsResult"),
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

      // ctx.get() reads the service without the property-accessor inject guard.
      const remote = ctx.get("remote.agentApproval");

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
      // menu as the "Agent 审批" preset (same place users switch Read-only /
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
        const timeoutSlot = React.useState("");
        const setTimeoutDraft = timeoutSlot[1];
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
              setTimeoutDraft(String(s.timeoutMs));
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
        const clearRecords = () => {
          remote
            .clearRecords()
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
        // One-click whitelist from an audit row: the recorded args are a
        // PREFIX of the real arguments JSON (the Host truncates at 2000
        // chars), so stripping the truncation marker keeps a valid substring.
        const whitelistRecord = (r) => {
          const args = String(r.args || "").replace(/…\[truncated\]$/, "");
          addRule({
            effect: "allow",
            tool: String(r.toolName),
            match: args,
            note: "来自审计 " + fmtTime(r.at),
          });
        };

        const providerOptions = [{ id: "", name: "默认（Harness 默认模型）" }].concat(
          dir ? dir.providers : [],
        );
        const modelOptions = [{ provider: "", id: "", name: "默认（Harness 默认模型）" }].concat(
          dir && dir.models ? dir.models.filter((m) => m.provider === provider) : [],
        );
        const defaultHint =
          dir && dir.defaultSelection
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
            h("h3", null, "Agent 审批权限"),
            h(
              "div",
              { className: "aapr-muted" },
              "一种新的权限模式：以 workspace-write 为基线沙箱；当工具请求提权（更宽的沙箱）时，由一个独立的审批 Agent 评估风险——安全、可逆、与任务相符的操作自动批准，破坏性、不可逆、越界或理由不符的操作直接拒绝。",
              h("br", null),
              "在输入框 /permission 菜单选择「Agent 审批」预设，或执行命令 /agent-approval on|off 为会话开启；审批记录见下方审计。",
            ),
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
                      setModel("");
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
                    disabled: dir === null,
                  },
                  modelOptions.map((m) =>
                    h("option", { key: m.provider + "/" + m.id, value: m.id }, m.id === "" ? m.name : m.name + "（" + m.id + "）"),
                  ),
                ),
              ),
              h(ui.Button, { variant: "primary", size: "sm", onClick: saveModel }, "保存"),
            ),
            h("div", { className: "aapr-muted" }, defaultHint),
          ),
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
                ? h("div", { className: "aapr-muted" }, "当前没有会话开启 Agent 审批。")
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
                          { onClick: () => disableSession(sid), title: "关闭该会话的 Agent 审批" },
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
          h(
            "div",
            { className: "aapr-card" },
            h("h3", null, "审批记录（最近 50 条，本地持久化保留 200 条，重启不丢）"),
            h(
              "div",
              { className: "aapr-row" },
              h(ui.Button, { variant: "ghost", size: "sm", onClick: refresh }, "刷新"),
              h(ui.Button, { variant: "ghost", size: "sm", onClick: clearRecords }, "清空记录"),
              note !== "" ? h("span", { className: "aapr-muted" }, note) : null,
            ),
            h(
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
                    ["时间", "会话", "工具", "结果", "风险", "模型", "耗时", "审批理由", "规则"].map((t) => h("th", { key: t }, t)),
                  ),
                ),
                h(
                  "tbody",
                  null,
                  state !== null && state.records
                    ? state.records.map((r, i) =>
                        h(
                          "tr",
                          { key: String(i) + "-" + String(r.at) },
                          h("td", null, fmtTime(r.at)),
                          h("td", null, String(r.sessionId)),
                          h("td", null, String(r.toolName)),
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
                      )
                    : h("tr", null, h("td", { colSpan: 9 }, h("span", { className: "aapr-muted" }, "暂无记录"))),
                ),
              ),
            ),
            h(
              "div",
              { className: "aapr-muted" },
              "悬停“审批理由”可查看完整理由与工具参数；“审批会话”前缀可在会话列表中找到审批 Agent 的完整会话记录。「加白」把一条已批准的操作存为放行规则（模型列显示 rule/trust 的行分别来自规则命中与会话内信任缓存）。",
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
    }

    exports.apply = apply;
    exports.inject = ["slots", "remote"];
    return module.exports;
  },
});
