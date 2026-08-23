/**
 * dsh-agent-approval — Client half (web bundle).
 *
 * Rendered by the DSH web shell via `window.__ModuleLoader__.load`. Adds:
 *
 *   1. A "Agent 审批" page in the Settings panel (`settings.section`):
 *      - approval model picker (provider + model, or the harness default),
 *      - judge timeout setting (fail-closed),
 *      - the list of sessions with the mode enabled,
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
  id: "dsh-agent-approval",
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
.aapr-chip{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:2px 10px;background:var(--dsw-alias-bg-layer-2);font-family:monospace}
.aapr-chip button{background:none;border:none;color:var(--dsw-alias-state-error-primary);cursor:pointer;font-size:12px;padding:0 2px}
.aapr-wrap{overflow-x:auto}
.aapr-table{width:100%;border-collapse:collapse;font-size:12px}
.aapr-table th{text-align:left;color:var(--dsw-alias-label-secondary);font-weight:500;padding:4px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);white-space:nowrap}
.aapr-table td{padding:4px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);vertical-align:top}
.aapr-cell{max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:normal}
.aapr-ok{color:var(--dsw-alias-state-success-primary);white-space:nowrap}
.aapr-no{color:var(--dsw-alias-state-error-primary);white-space:nowrap}

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
   currentColor mask so hover/selected/disabled colors all follow the shell. */
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
        const items = document.querySelectorAll('[role="menu"] button[role="menuitem"]');
        for (let i = 0; i < items.length; i++) {
          const button = items[i];
          const text = button.textContent ? button.textContent.trim() : "";
          if (text === currentLabel) button.setAttribute(PERM_ITEM_MARKER, "");
          else button.removeAttribute(PERM_ITEM_MARKER);
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
                    state.enabledSessions.map((sid) =>
                      h(
                        "span",
                        { key: sid, className: "aapr-chip" },
                        String(sid).slice(0, 8),
                        h("button", { onClick: () => disableSession(sid), title: "关闭该会话的 Agent 审批" }, "✕"),
                      ),
                    ),
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
                    ["时间", "会话", "工具", "结果", "风险", "模型", "耗时", "审批理由"].map((t) => h("th", { key: t }, t)),
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
                        ),
                      )
                    : h("tr", null, h("td", { colSpan: 8 }, h("span", { className: "aapr-muted" }, "暂无记录"))),
                ),
              ),
            ),
            h(
              "div",
              { className: "aapr-muted" },
              "悬停“审批理由”可查看完整理由与工具参数；“审批会话”前缀可在会话列表中找到审批 Agent 的完整会话记录。",
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
