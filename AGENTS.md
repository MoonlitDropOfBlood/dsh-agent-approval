# AGENTS.md — dsh-agent-approval

面向 AI agent 与协作者的开发指南。**读这里再动手**，尤其"关键机制"和"重要注意事项"，记录了本项目踩过的大量坑。

## 项目是什么

一个 **DeepSeek Harness（DSH）双面（Host + Client）插件**：新增一种 **Agent 审批** 权限模式。

- 以 **workspace-write 为基线沙箱**；工具请求提权（更宽沙箱，如 `sandbox_permissions`）时，不再弹人工审批，而是交由**一个独立的审批 Agent（subagent）裁决**。
- 审批 Agent 在**独立会话**里运行：零父级上下文、全局工具全部空白（`toolFilter: {allow:[]}`）、审批策略被委派机制钉死为 `never`（不可能递归再审批），必须通过 `structured_output` 结构化工具给出裁决：`{ decision: approve|reject, riskLevel, rationale }`。
- **风险即拒绝**：破坏性 / 不可逆 / 越界 / 理由与实际参数不符 → `reject`；只有"安全、可逆、与任务相符、理由诚实"才 `approve`。
- **Fail-closed**：审批 Agent 启动失败、超时、结果不合法、请求被取消 → 一律按拒绝处理（`unavailable`/`cancelled`），绝不静默放行。
- **设置面板**新增 **Agent 审批** 页（`settings.section`）：配置审批模型（provider/model，或 Harness 默认模型）与审批超时（两者**持久保存**，重启不丢）、查看已开启会话、**最近审批记录（审计，本地持久化）**（结论/风险/模型/耗时/理由，悬停看完整理由与工具参数）。
- 输入框 `/permission` 菜单的「Agent 审批」预设 + `/agent-approval on|off` 命令为当前会话开关（**刻意没有 composer chip**——开关本就属于权限菜单，菜单旁边再放一个属冗余，已移除）；关闭时**恢复开启前的权限旋钮**（沙箱模式 + 审批策略）。

## 目录结构

```
dsh-agent-approval/
├── package.json          # ESM 双面包：dsh.client: {platform:"web"} + exports(., /client, /typert, /package.json)
├── index.js              # Host 半：AgentApprovalService（TypertRemoteService 子类，类插件）
├── client.js             # Client 半：window.__ModuleLoader__.load bundle（设置页 + Remote 调用）
├── typert.host.js        # Typert Host manifest：agentApproval Remote 服务的 schema/调用描述
├── cordis.patch.yml      # dsh bundle patch（挂载行 + permission 预设表覆盖）
├── scripts/patch-glyph.mjs # 可选：权限菜单图标补丁（标准安装不自动执行）
├── .github/workflows/release.yml  # 打 v* 标签时构建并发布 GitHub Release
├── AGENTS.md             # 本文件
├── README.md
└── LICENSE               # MIT
```

## 关键机制

### 1. DSH 正式插件 = 三件套（Host / Client / Typert）

| 文件 | 作用 | 被谁加载 |
|---|---|---|
| `index.js` | Host 半：Cordis **类插件**（导出 Service 类），注册 `agentApproval` 服务 | cordis loader（composition `insert` 行） |
| `client.js` | Client 半：浏览器 UI bundle | `client-modules`（扫描 `dsh.client` 声明 → 注入 `window.__DSH_BOOT__`） |
| `typert.host.js` | 描述 `agentApproval` 服务的 Remote 方法（wire schema / invocation） | `typert-loader`（扫描包的 `./typert` 导出） |

三者的**关键名字必须一致**：
- `index.js` 导出的类名 → `AgentApprovalService`
- `typert.host.js` 的 `model.services[].key` / `exportName` → `agentApproval` / `AgentApprovalService`；每个 invocation 的 id/service/namespace/method 与 client 描述符一一对应
- `client.js` 的 `CLIENT_REMOTE` 描述符 id → `dsh-agent-approval#agentApproval/<method>`，调用走 `ctx.get("remote.agentApproval").<method>()`
- `package.json` 的 `exports`：`"."`、`"./client"`、`"./typert"`、`"./package.json"`（**必须**有 `./package.json`，否则 `require.resolve("<pkg>/package.json")` 失败）

### 2. Host 半：类插件 + Remote 方法

```js
export class AgentApprovalService extends TypertRemoteService {
  static inject = ["approval", "subagents", "agents", "timer"];
  constructor(ctx, config) { super(ctx, "agentApproval"); }  // 必须传精确服务键
  [Service.init]() {
    markRemoteMethod(this, "getState", "getState");
    // ...每个 Remote 方法都要标记
  }
}
```

- **不要导出插件对象 `{apply}`**；导出 Service 类（loader 用 `new Callback(ctx, config)` 实例化，第二个参数是插件 config 不是服务键——这是 dsh-archive-manager 踩过的构造坑）。
- `Remote` 装饰器**不能直接写**（Node ESM 不支持 Stage 3 装饰器），用 `markRemoteMethod()` 手动驱动（同 token-stats / archive-manager）。
- `inject` 里是**硬依赖**（缺任何一个插件进入 waiting）：`approval`（审批瀑布 + setPolicy）、`subagents`（spawn provider）、`agents`（sessionId→Agent 查找）、`timer`（`ctx.timeout` 竞速）。可选面（`llm`/`agentDefaultModel`/`systemPrompt`/`commands`）用 `this.ctx.get()` / `this.ctx.inject([...], scope => ...)` 挂载，缺席时优雅降级。

### 3. 核心：prepend 抢占 `approval/request` 瀑布（本插件最重要的机制）

- DSH 的审批流：工具提权 → `ctx.approval.request()` → 服务先应用 session policy（`ask` 才继续）→ 派发 `approval/request` **waterfall** → 组合的 answerer 链（web 端是 host-apiproxy 的**人工弹窗 answerer**，它在组合加载时就注册了）。
- Cordis waterfall 的 hook 顺序 = 注册顺序（先注册 = 最外层 = 最先执行）。本插件**晚于** apiproxy 注册，所以必须：

```js
this.ctx.on("approval/request", (req, next) => this._onApprovalRequest(req, next), { prepend: true });
```

`{ prepend: true }` 把监听器 **unshift 到队首**，从而先于人工 answerer 执行。已开启的会话：直接裁决并返回 outcome（`allowed-once`/`rejected`/...），**不调用 `next()`**（否决了后续链条）；未开启的会话：原样 `return await next()`，人工弹窗行为完全不变。
- **监听器为什么收得到所有会话的派发**：审批派发带 `scopeTarget(this, req.agent)` 过滤器，untagged 监听器（本插件挂在 profile 根组合，无 scope 标签）一律放行。**因此本插件必须挂在 HOST 平面**（`cordis.patch.yml` 的 `- insert:` 行），不要放进任何 isolate realm。
- **为什么开启时要切到 `ask`**：policy 为 `never` 时 `decide()` 在瀑布之前就直接返回 `rejected`，监听器根本不会执行。`_setEnabled(on)` 在开启时记住会话的**有效**旋钮值（override ?? 组合默认——一个活在 `never` 组合默认下的会话，关闭时必须回到 `never` 而不是"无覆盖"状态），然后：沙箱用 `session.append("sandbox/mode", { mode: "workspace-write" })`（与官方 `setSandboxMode` 完全同一事件形态）；审批策略用 `approval.setPolicy(agent, "ask")`（规范写路径：追加 `approval/policy` 事件 + 给模型注入切换通知）。关闭时经同一对规范 setter 恢复记住的值（值未变化时 setter 自动 no-op）。

### 4. 审批 Agent：一次性 `spawn` 子代理 + 结构化裁决

```js
const run = await this.ctx.subagents.start("spawn", {
  label: "approval-judge",
  prompt: [{ type: "text", text: judgePrompt }],
  parent: agent,              // 用于派生 workspace / lineage / 深度
  signal: req.signal,         // 请求取消 → 子代理取消
  agentOptions: { provider, model },   // 配置了审批模型时才传
  outputSchema: VERDICT_SCHEMA,        // { decision, riskLevel, rationale }
  toolFilter: { allow: [] },           // 全局工具全部空白（structured_output 是 scoped 注册，不受影响）
  persona: APPROVER_PERSONA,           // 独立安全审批员人格，fail-closed 倾向
});
```

- **裁决 schema 必须是 JSON-Schema 受限子集**（`assertObjectJsonSchema`）：只允许 `type/properties/required/additionalProperties/items/enum/const` + 注解。不要写 `pattern`、`format`、数值范围。
- **零工具**：`toolFilter: {allow: []}` 合法（空 allow 数组不是 no-op——no-op 判定只针对 allow/deny **都缺失**），审批员只能"看"和"判"，不能"做"。
- **不会递归审批**：DSH 委派机制自动把子代理的审批策略钉死为 `never`（`captureDelegatedPolicyOverrides`），子代理自己提权只会被直接拒绝。
- **结果读取**：`run.result`（Promise，不 reject 业务失败）→ `result.structured`（合法裁决）+ `result.stopReason === "completed"`。两者任一不满足 → `unavailable`（fail-closed）。
- **竞速**：`Promise.race([run.result, abortRace, this.ctx.timeout(timeoutMs)])`，`finally` 里 `run.dispose()`。超时/取消/基础设施故障分别映射 `unavailable`/`cancelled`。
- **给审批员看的材料**：从会话日志按 `callId` 倒查 `tool/call` 事件的 `arguments` 原始 JSON（**精确命令**，不是转述）、`req.reason`（工具方的提权理由）、workspace cwd、以及**最近 2 条真实用户消息**（`user/message` 且 `source.kind === "user"`，每条截断 800——任务的 ground truth）。审批提示词明确 APPROVE 四条件与 REJECT 清单，并要求"存疑即拒"。
- **裁决一致性口径**：判"操作 vs 用户任务"的**客观对齐**，不依赖请求方理由的措辞水平——理由只是辅助证据：操作本身明显安全且与任务相符时，理由写得简略**不拒**；但理由与实际参数造假/不符仍**照拒**（读过审核标准的 agent 不能靠文笔获得优待）。
- **开发流程口径**（端到端任务不被卡死的关键）：提权档位只有粗粒度两档，审批员**判实际操作而非档位名**——项目自带的安装/构建/部署脚本写其文档指定的安装路径（如工具自身 profile 目录）、覆盖自身已安装的文件（可从源码再生成）、读调试所需的工具自有配置/日志，都算"任务明确所需"可 approve；但**修改操作系统或其他应用的数据**仍一律 reject。

### 5. 审计记录

- 内存环形数组，上限 200 条，`getState()` 返回倒序最近 50 条；**每条同时追加落盘** `<DSH_HOME>/agent-approval/records.jsonl`（JSONL，一行一条），启动时读回最近 200 条并把文件压实回上限（防无限增长），`clearRecords` 同步清空文件。每条：时间、会话（短 id）、工具、结论、风险等级、审批模型、耗时、理由（截断 600）、`childSessionId`（审批 Agent 自己的会话短 id——在会话列表里能找到完整推理记录）。
- **必须整形状构造**（`typert.host.js` 的 result schema 是 strict）：每个字段都在、类型正确，数组用 `.readonly()`。新增字段要同步改三处（index.js 构造、typert schema、client 展示）。

### 6. Client 半：bundle 格式

- 必须 `window.__ModuleLoader__.load({ id, factory })`，`exports.inject = ["slots", "remote"]`。
- **按钮一律用官方 Button 原子**：`const ui = require("@deepseek-ai/dsh-client-ui-primitives")`，`h(ui.Button, { variant: "primary"|"ghost"|"outline", size: "sm", onClick }, "…")`。自定义 `.aapr-btn` 按钮样式已移除——它不跟 `--dsw-alias-button-*` token 家族，深色模式下难看（与 dsh-memory-manager 踩过的同一个坑，同一个修法）。
- **Remote 命名空间必须自挂载**：`await ctx.remote.$mount(CLIENT_REMOTE)`（dsh-api-remotes 只挂载官方命名空间），然后 `ctx.get("remote.agentApproval")`。描述符与 `typert.host.js` 的 invocation 一一对应；浏览器没有 zod，用 passthrough schema（`{ parse: (v) => v }`）。
- **返回值双层信封**：gateway 返回 `res.value` = Host 方法的 `{ ok, value }` 信封，client 的 `pick()` 做容忍双形状解包 + 双层错误上抛（token-stats 踩过"多包一层"的坑）。
- **CSS 注入**用 `document.createElement("style")` + `ctx.effect(() => () => styleTag.remove())`；样式一律用 `--dsw-alias-*` 主题变量。
- 一个 Slot：`settings.section`（id `agent-approval`，order 30，label `() => SETTINGS_LABEL`）。曾有过 `conversation.input.left` 的「🛡 审批」chip（id `agent-approval-toggle`，order 15，InputZone owner props 传 `props.session`，只读 `sessionId` 叶子字段），已移除——开关本就属于 /permission 菜单，菜单旁边再放一个开关是冗余。
- **设置导航图标**：DSH 0.1.x 的 `settings.section` 只投影 `id/order/label`，设置壳对每个外部 section 统一画通用齿轮（`client-ui-settings-general` 的 `navIcon()`，没有公开图标字段）。client.js 里 `registerSettingsNavIcon(SETTINGS_LABEL)` 用 MutationObserver 给 `[role="dialog"] nav button` 中文本等于 section label 的行打 `data-dsh-agent-approval-settings-nav` 标记，CSS 再隐藏 `>svg:first-child` 齿轮、用 `currentColor` mask 画 shield-check Lucide 图标（16px，跟随原生 hover/active 颜色）。换图标只需替换 CSS 里 data URI 的 SVG path（Lucide，24×24，stroke-width 2，stroke 用 black——mask 只取 alpha）。
- client.js 里**不要用 `?.` / `??`**（与 token-stats 保持一致的保守写法），用 `&&`/`||`；不要 `import`，用 `require("react")`。

### 7. 权限菜单集成（`permission` 行覆盖 + `permission/preset` 事件联动）

权限菜单（输入框 `/permission` 控件）的选项来自 **`dsh-permission-presets` 的 Config 预设表**；Web 端切换 = 执行 `/permission <preset>` 命令 → 追加 `permission/preset` 事件 + 旋钮事件。要让「Agent 审批」出现在菜单里：

1. **包的 `cordis.patch.yml`（bundle patch）里写 `- id: permission` 覆盖行**，把 `agent-approval`（bundle = workspace-write + ask）加进预设表。**patch 语义是整行替换 config（不合并）**，所以必须重述全表（read-only / workspace-write / **agent-approval** / danger-full-access）——**声明顺序即菜单顺序**，agent-approval 排在 Full access 上面；DSH 升级若改了基础表要手动同步。
2. **菜单图标来自编译进官方 `dsh-client-ui-conversation` 的硬编码映射 `permissionGlyphs`**（菜单行 + 触发按钮共用；源码注释明说 "host-configured names outside the design set get none"），**没有公开注册口**。`scripts/patch-glyph.mjs` 的 `patchPermissionGlyph()` 直接补丁该编译产物：往 `const permissionGlyphs = {` 后插入 `agent-approval` 条目（描边盾牌 + 填充 AI 星形，与出厂三个图标同风格同 viewBox）。幂等；**DSH 升级会重装原版 bundle，重跑 `npm run patch:glyph` 即可再补丁**；找不到锚点时降级为警告（菜单只是没图标，功能不受影响）。
3. **同 bundle 歧义规则**：`agent-approval` 与 `workspace-write` 的旋钮值完全相同；`derive()` 里"仍匹配的最后选中预设"赢得平局，所以**菜单显示什么完全由最后的 `permission/preset` 事件决定**。因此：命令开启时也追加 `permission/preset: agent-approval`（菜单同步显示）；命令关闭时按恢复的旋钮值回写正确的预设事件（跳过我们自己的条目），否则菜单会卡在「Agent 审批」。
4. **事件联动**（`session/event` 监听 `permission/preset`）：
   - 选中 `agent-approval` → `_enableCore`（此刻旋钮事件还没落，捕获的 prev 恰是切换前的值；我们写的旋钮值与预设服务随后要写的相同，它检查后跳过，无重复事件）。
   - 选中其他预设 → 只删 bookkeeping，**不恢复旋钮**（预设服务马上写自己的旋钮，恢复会打架）。
5. **跨重启存活**：`agent/created` 监听在（重）发布时折叠日志——`permission/preset` 折出 `agent-approval` 就重新启用。spawn 的审批员子会话不带 preset 事件（无 seed），不会递归重启用；fork 子会话 seed 里可能带父级的 preset 事件 → 会继承该模式（有意语义：模式跟随会话的工作；"later child switches win" 是官方允许的后来者覆盖）。
6. **防御**：`_presetRegistered()` 先确认表里有 `agent-approval` 才追加 preset 事件——没装覆盖行时，追加会被会话不变量（unknown preset）直接抛错。
7. （已随 composer chip 的移除而作废）曾有的 chip 每 10s 轮询一次 enabled 状态；若未来重加 chip，注意 InputZone 的 ConversationSnapshot **没有** projections 字段，读不了 `permissions` 投影，只能轮询。

### 8. 标准安装 = dsh bundle（package.json 声明 + 包内 cordis.patch.yml）

本插件是**标准 DSH bundle**：`package.json` 的 `dsh.bundle.patch` 指向包内 `cordis.patch.yml`，用官方 `dsh plugin` 命令安装：

1. `dsh plugin --profile web add <本地路径或包>`：pnpm 把插件装成 profile 的 npm 依赖（本地路径走 `link:` 软链，改代码即生效），并把包名追加到 profile `package.json` 的 `dsh.profile.bundles`。
2. 启动时 DSH 应用包内 `cordis.patch.yml`，做两件事：**`- insert:`** 新增插件挂载行（**不要**对不存在的 id 用普通 `- id:`，会报 "entry not found"）；**`- id: permission`** 覆盖预设表行（该 id 已存在，覆盖合法）：

```yaml
# cordis.patch.yml（随包分发）
- insert:
  - id: agent-approval
    name: '@duke-dsh-plugins/dsh-agent-approval'

- id: permission
  name: '@deepseek-ai/dsh-permission-presets'
  config:
    presets:
      read-only: { sandbox: read-only, approval: ask }
      workspace-write: { sandbox: workspace-write, approval: ask }
      agent-approval:
        sandbox: workspace-write
        approval: ask
        name: Agent 审批
        description: workspace-write base; an independent approval agent judges every escalation, risky ones are rejected.
      danger-full-access: { sandbox: danger-full-access, approval: never }
```

3. **不要**再在 profile 的 `cordis.patch.yml` 里手工插这些行，否则同一 id 重复挂载、permission 表重复覆盖。
4. 重启 DSH。**必须重启**，Host 加载、typert 注册、client bundle 注入都在启动时发生。
5. 卸载：`dsh plugin --profile web remove dsh-agent-approval`（自动从 bundles 列表移除）。
6. **可选（权限菜单图标）**：菜单图标在官方 bundle 的硬编码映射里，标准安装不会补——本地开发想要图标就 `npm run patch:glyph`（见第 7 节）。

## 开发 / 验证

```bash
npm run check            # node --check index.js client.js typert.host.js scripts/patch-glyph.mjs
dsh plugin --profile web add /path/to/dsh-agent-approval   # 安装/重装到本机 DSH profile
npm run patch:glyph      # 可选：权限菜单图标（幂等）
```

改插件后**必须重启 DSH 进程**才生效。验证：
1. 输入框 `/permission` 菜单出现第四项 **Agent 审批**；设置 → 侧栏导航出现 **Agent 审批** 页（模型/超时可保存）。
2. 用 `/agent-approval on` 或菜单选 **Agent 审批** 为会话开启（两条路径等价）；输入框左侧**不再有**「🛡 审批」chip。
3. 开启后让工作区内命令触发一次提权重试（`sandbox_permissions`）：**不弹人工审批**，片刻后工具结果即为批准/拒绝；设置页出现一条审计记录（含风险等级与理由）。
4. `/agent-approval off` 关闭：沙箱模式与审批策略恢复开启前的值，菜单同步切回对应预设；再次提权回到人工弹窗（ask）或原策略行为。
5. 菜单切到 danger-full-access：模式自动关闭（`permission/preset` 事件联动，立即生效）；菜单切回 Agent 审批：模式自动开启，无需手动执行命令。
6. 把审批超时调成 30000ms、审批模型指向一个不存在的路由 → 提权应 fail-closed 拒绝并记录 `unavailable`。

## 发布

打 `v1.0.0` 标签推送 GitHub，`.github/workflows/release.yml` 自动 `npm pack` 并发布 GitHub Release（需要 `GH_TOKEN` secret，权限 `contents:write`）。

## 常规注意事项

- **不要直接编辑 `~/.dsh/profiles/web/cordis.yml`**（生成文件，patch 写在 `cordis.patch.yml`）。
- 监听器**绝不能抛异常**：瀑布层的兜底会把异常归一为 `unavailable`，但要自己 catch 并记录，否则审计里看不到原因。
- 声称（claim）的范围是"该会话的**所有** approval 请求"——不止 pwsh/bash 提权，也包括任何 `tools/pre-execute` 产生的人工 ask。这是有意语义（"帮我审批"），提示词写成通用审批口径。
- `approval.setPolicy` 会在模型上下文里注入 "changed by the user" 通知——用户确实主动开了开关，语义可接受；不要绕开它手写 `approval/policy` 事件（会丢失通知）。
- 审批模型未配置时使用 **Harness 默认路由**（`agentDefaultModel.currentSelection()`；该可选服务缺席或解析为空时才退化为继承请求会话路由）；配置后走 `agentOptions` 精确覆盖。**刻意不跟随请求会话的模型**——审批口径必须稳定可预期，不随各会话的模型切换而漂移。
- 审计记录**持久化**在 `<DSH_HOME>/agent-approval/records.jsonl`（重启保留最近 200 条）；审批模型与超时持久化在同目录 `config.json`（重启恢复，不再回落默认）。持久化失败是 best-effort 静默降级（内存态仍可用），绝不影响审批主流程。DSH 的权威审计仍在会话日志的 `approval/asked` + `approval/decided` 事件对（本插件不破坏该配对，只在瀑布层给结论）。
