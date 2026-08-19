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
 * preset, registered by scripts/install.mjs's profile patch) and the
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
`;

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
          { name: "settings.section", id: "agent-approval", order: 30, label: () => "Agent 审批" },
          AgentApprovalSection,
        ),
      );
    }

    exports.apply = apply;
    exports.inject = ["slots", "remote"];
    return module.exports;
  },
});
