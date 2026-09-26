# 方案：Harness LLM 直连裁决后端 + 逐调用审查模式（agent-review）

> 状态：**已定稿**（决策点已拍板，见第 4 节）。参照物：官方 `@deepseek-ai/dsh-experimental-auto-review@0.1.7-rc.2`（本机安装目录已逐行核对）。
> 本方案只做设计，不动代码。

## 0. 目标（两个增量）

| | 功能 | 一句话 |
|---|---|---|
| **A** | **Harness LLM 直连裁决（默认裁决方式）** | 参考官方审批器的 `ctx.llm.stream()` 形态自建一次性流式调用，**输入/输出与现有 spawn 审批子代理完全同构，仅调用方式不同**；**LLM 直连成为默认裁决方式**（不启动 subagent，消除子会话带来的轻微上下文污染），spawn 子代理降级为可选的隔离裁决方式；用于现有 `agent-approval` 模式的提权裁决 |
| **B** | **逐调用审查模式（`agent-review` 预设）** | 把官方 `auto` 的形态做成插件可选模式：`tools/pre-execute` 拦截 + `danger-full-access` + `ask`，裁决器用 **Jev**；**开启门槛 = 设置页已启用 Jev** |

B 不依赖 A 的新代码（Jev 材料层已存在），但 A 的公共抽取让两者共享同一份 ground truth；A 可独立先行交付。

---

## 1. 官方参照物的事实基础（已核对源码）

`@deepseek-ai/dsh-experimental-auto-review/lib/index.js` 的关键机制，B 直接对齐：

1. **拦截点**：`ctx.on("tools/pre-execute", handler, { prepend: true })`——覆盖**每个 native 调用 + 每个已开始的 PTC `tools.*` inner 调用**，唯独**排除外层 `run_code` transport**（`exec.parent === undefined && exec.name === RUN_CODE_NAME` 直接 `next()`）。
2. **预设**：`permissionPresets.registerAuto(admit)` 注册保留字预设 `auto`（`AUTO_PRESET_SPEC = { sandbox: "danger-full-access", approval: "ask" }`）。**`auto` 是保留字，配置表里不可用同名 key**（`dsh-permission-presets` 构造期 throw）——我们必须用自己的 key。
3. **裁决器**：`ctx.llm.stream({ provider, model, system: REVIEW_POLICY, messages, temperature: 0, signal })`——复用**当前请求会话的 provider/model**，不是子代理。响应是「零或多个 reasoning block + 恰一个 text block + terminal stop」，text 是严格 JSON。
4. **严格协议**（`parseDecision`）：只有 `{risk:"low",decision:"allow"}`、`{risk:"medium",decision:"allow"|"deny"(+reason?)}`、`{risk:"high",decision:"deny"(+reason?)}` 合法；`low+deny`/`high+allow`/`allow+reason` 全部非法；重复 JSON member 也非法。
5. **deny 语义**：审批策略 `ask` 下 reviewer deny → **回退人工弹窗**（`{kind:"ask"}`，保留 reviewer 原始理由）；`never` 下才是 final deny（委派 child 固定 `never`）。reviewer **失败**（流错误/非法输出）→ 调用以错误失败，body 不执行——不是放行。
6. **审计**：官方**不持久化** risk/prompt/reasoning/raw response（README 明文）。我们反过来：持久化是本插件卖点。
7. **已知局限（官方自述）**：模型分类可能出错、无确定性豁免/持久 grant/可配置策略/重试层；外层 `run_code` 与 PTC 内直接 Node 效果不经 inner-tool 审查；默认关闭，属实验层。

---

## 2. 功能 A：Harness LLM 直连裁决后端

### 2.1 定位（关键修正：LLM 直连是**默认**裁决方式，不启动 subagent）

**本意**：现有 spawn 审批子代理会创建子会话（会话列表多一条审批员会话、请求会话日志写 `subagent/descriptor`、委派机制注入上下文）——这些**轻微的上下文污染**是要消除的对象。LLM 直连一次无状态 stream 调用即裁决，零子会话。

**输入/输出与现有 subagent 路径完全同构，仅调用方式的区别**：

| | subagent 路径（现状） | LLM 直连路径（新，默认） |
|---|---|---|
| 人格 | `persona: APPROVER_PERSONA` | **同一文本** → `system` |
| 输入 | `prompt: [{ type:"text", text: _judgePrompt(session, req, argsRaw) }]` | **同一文本** → `messages[0]` user 消息 |
| 输出 | `outputSchema: VERDICT_SCHEMA` → `result.structured` | **同一 schema** → 对 JSON text 输出做 VERDICT_SCHEMA 等价校验 |
| 完成判定 | `result.stopReason === "completed"` | terminal finish 且 `reason.kind === "stop"` |
| 调用 | `subagents.start("spawn", {...})` | `ctx.llm.stream({ provider, model, system, messages, temperature: 0, signal })` |
| childSessionId | 审批员子会话短 id | 恒空（无子会话） |

`_judge` 分支变为：

```
规则表短路 → 会话内信任缓存 → 裁决器：
  ├─ provider === "typesafe"        → _judgeWithJev（HTTP 直连，置信度门控）
  ├─ judgeMode !== "subagent"       → _judgeWithLlmStream（ctx.llm.stream，【默认】）
  └─ judgeMode === "subagent"       → spawn 审批子代理（可选"隔离裁决"方式，保留现有代码）
```

- 设置里的「Harness 默认模型 / 指定 provider/model」两个路由选项**语义不变**，只是实现从 spawn 换成 LLM 直连；新增一个**「裁决方式」**选择：`llm`（默认）/ `subagent`（隔离会话，legacy）。
- spawn 路径保留为可选：有人偏好"独立会话物理隔离"的裁决形态；代码已在，维护成本低。若你想彻底移除也可以（纯删分支），默认保留。
- 动机对比官方：官方 auto-review 的裁决器就是一次 `ctx.llm.stream()`，没有子代理——功能 A 即把这个形态引入本插件，且保持你现有的审批口径（persona + judgePrompt + VERDICT_SCHEMA）原封不动。

### 2.2 服务面与依赖

- `this.ctx.llm`——**运行前提，不写缺席兜底**（用户裁定：llm 服务缺席连主 agent 都跑不起来）：直接 `this.ctx.llm.stream(...)`，不加回退分支、不加 `llmStreamAvailable` 字段。**不新增 npm 依赖**：流聚合自建，不 import 官方的 `BlockAssembler`。
- 路由解析完全复用现有 `_judgeRoute()`：`_model` 空 = `agentDefaultModel.currentSelection()`，指定 provider/model = 精确覆盖（spawn 的 `agentOptions` 与 stream 的 `{provider, model}` 用同一个 route）；解析为空则 unavailable。
- 复用现有 `timer`（`ctx.timeout` 竞速）与 `req.signal` 联动，与 `_judgeWithJev` 同构。

### 2.3 裁决输入/输出（与 subagent 路径同构，仅输出指令尾巴按调用方式参数化）

- **输入原样复用**：`system` = `APPROVER_PERSONA` 全文（含"你自身的权限约束只约束你自己"消歧句——LLM 直连下无害，**保持两路径文本一致**）；user 消息 = `_judgePrompt(session, req, argsRaw)` 全文（材料 + APPROVE 四条件 + REJECT 清单 + 开发流程口径 + 误杀治理，一字不改）。
- **唯一文本差异**——输出指令尾巴参数化（`outputInstruction`）：
  - subagent：`Report the verdict via the structured_output tool only.`（现状）
  - LLM 直连：`Respond with exactly one JSON object matching the schema and nothing else.`
- **输出**：text 解析出的 JSON 必须通过 **`VERDICT_SCHEMA` 等价校验**（`decision ∈ {approve,reject}`、`riskLevel ∈ {low,medium,high}`、`rationale` 为 string、三字段必填、`additionalProperties: false`）——与 `result.structured` 的契约完全一致，审计/信任缓存/后续逻辑零改动。校验失败 → unavailable（fail-closed）。
- `temperature: 0`。

### 2.4 流式解析（自建轻量聚合）

按官方 `readDecision` 语义自实现（约 30 行，零依赖）：

1. 遍历 `ctx.llm.stream()` 的 chunk 流，拼接 text 增量，忽略 reasoning 增量（保留首个 finish 之前的全部）；
2. 要求**恰好一个 terminal finish 且 `reason.kind === "stop"`**（error/aborted/其他 → unavailable）；
3. finish 之后再有 chunk → unavailable；无 finish → unavailable；
4. text 剥 code fence / 提取首个平衡 `{...}` 后 `JSON.parse` → 2.3 的 VERDICT_SCHEMA 等价校验。

> 开发期注意：chunk 具体形状以 0.1.7-rc.2 的 `dsh-llm` 为准做一次冒烟（官方 `readDecision` 是权威参照）。若聚合形状判断有误，备选是从宿主 `node_modules` 解析 `@deepseek-ai/dsh-llm` 的 `BlockAssembler`（做 optional peer，不进 dependencies）。

### 2.5 失败 / 超时 / 取消语义（fail-closed 不变）

| 情况 | 映射 |
|---|---|
| 流错误 / 非法输出 / 无 finish / 路由不可解析 | `unavailable`（拒绝，不放行） |
| `ctx.timeout(timeoutMs)` 竞速胜出 | `unavailable` |
| `req.signal` 取消 | `cancelled` |
| 合法 approve / reject | `allowed-once` / `rejected` |

approve 照旧写信任缓存（指纹 = `工具名 + "\n" + 参数原始 JSON`）。

### 2.6 公共重构（最小化——输入输出本来就要复用）

- **不做大改**：`_judgePrompt()` 与 `APPROVER_PERSONA` 保持现状，仅把"输出指令尾巴"抽成参数（见 2.3），两路径共用同一函数。
- B 模式材料构造（多 tool description/parameters、走 pre-execute 而非 approval/request）届时抽 `_reviewMaterials()` 供 B 专用；Jev `_jevStateOf` 不动。
- 零行为变化保证：subagent 路径的 prompt 文本除输出尾巴外逐字不变（存量语义：消歧句、开发流程口径、误杀治理全部原样）。

### 2.7 审计

- model 列：LLM 直连记 `llm(<provider>/<model>)`（即 `_judgeRoute().label`）；`childSessionId` 恒空（无子会话——这正是消除上下文污染的体现）。spawn 可选路径照旧记子会话短 id。
- 无置信度输出（不像 Jev 有概率分布）——理由列只记 rationale。

### 2.8 设置 UI 与 wire 同步

- **Provider 下拉不变**（Harness 默认模型 / 指定 provider/model / TypeSafe Jev 三项照旧）；「审批模型」卡片新增 **「裁决方式」** 下拉：`LLM 直连（默认）` / `隔离子代理（legacy）`。默认 LLM 直连——升级后即生效，无需用户配置。
- wire 三处同步 + codec 双格式（`schema` + `create: () => schema`）：`getState` 新增 `judgeMode`；`setModel`（或新增 `setJudgeMode`）持久化裁决方式到 config.json；改完跑 `npm run check`（内含双代 Typert 契约校验）。

---

## 3. 功能 B：逐调用审查模式（`agent-review` 预设）

### 3.1 预设定义（cordis.patch.yml 整表重述）

```yaml
- id: permission
  name: '@deepseek-ai/dsh-permission-presets'
  config:
    presets:
      read-only: { sandbox: read-only, approval: ask }
      workspace-write: { sandbox: workspace-write, approval: ask }
      agent-approval: { ...旋钮不变..., name: 自动审批 }   # ← 显示名改名（见 3.10）
      agent-review:                     # ← 新增（key 避开保留字 auto/custom）
        sandbox: danger-full-access
        approval: ask
        name: 自动审查
        description: Full access base; every tool call is reviewed by the Jev judge before execution; risky calls are rejected.
      danger-full-access: { sandbox: danger-full-access, approval: never }
```

- **声明顺序即菜单顺序**：自动审查 排在 自动审批 之后、Full access 之前。
- patch 是整行替换，DSH 升级改基础表要手动同步（现有约定不变）。
- 官方 `auto`（若安装了 experimental-auto-review 层）是 `registerAuto` 动态注册，与我们的静态 key 不冲突；但**两层不要同开会话同时用**（见风险）。

### 3.2 开启门槛（Jev gate，三层）

**为什么 gate Jev**：逐调用审查 = 每个工具调用一次裁决，spawn 子代理撑不起这个开销；Jev 亚秒级直连是唯一合适的裁决器（本方案按用户要求：gate 只认 Jev，不认 LLM stream——后者留给普通提权裁决）。

1. **UI 门槛**：client 用 MutationObserver（复用 glyph patch 的观察器套路）在 Jev 未配置（`getState().jev` 无有效 key 且 env `TYPESAFE_API_KEY` 不可用，或 provider ≠ typesafe）时**隐藏/禁用**「自动审查」菜单行（`data-dsh-agent-approval-review-item` 标记 + CSS `display:none`），并在 `/agent-review on` 命令路径返回明确错误提示。
2. **host 校验**：`_enableCore(mode:"review")` 入口再校验一次 gate；不过 → 拒绝开启并提示。
3. **联动兜底**：`permission/preset` 事件折出 `agent-review` 但 gate 不过（竞态/外部写事件）→ **fail-closed 回退**：立即 `permissionPresets.set(session, "agent-approval")`（回到 workspace-write + ask），审计记一条 `unavailable`（理由注明 gate 未过），绝不让会话裸奔在 Full access + 无人裁决。

### 3.3 拦截链路（`tools/pre-execute` 瀑布）

```js
this.ctx.on("tools/pre-execute", (exec, next) => this._onPreExecute(exec, next), { prepend: true });
```

handler 逻辑（全程 try/catch，监听器绝不抛错）：

```
exec.agent 缺席                          → next()
exec.parent === undefined &&
  exec.name === RUN_CODE_NAME            → next()   // 外层 run_code transport 不审（对齐官方）
该会话未以 review 模式 enable            → next()
规则表命中（deny → {kind:"deny"} /
         allow → next()）                // 短路，零模型开销（官方没有的我们的优势）
信任缓存命中（同会话同参数指纹）          → next()   // 审计记 trust
否则 → _judgeWithJev(材料 + tool schema)：
  approve → next()（放行执行）
  reject  → {kind:"deny"} 直接拒绝，body 不执行（fail-closed，不转人工）
  unavailable/cancelled/低置信 → fail-closed 按拒绝处理（同样不转人工）
```

- **覆盖面**：native + PTC inner 调用都审（对齐官方；outer `run_code` 排除）。`exec` 自带 name/arguments/signal/parent/schema，无需官方那套 surface 日志重建——我们的材料只需 ground truth（用户消息）+ 待审动作。
- **取消**：`AbortSignal.any([exec.signal, lifecycle.signal])`（lifecycle 供插件卸载/模式关闭时统一中止在途裁决，参照官方 `lifecycle` AbortController）。

### 3.4 裁决链顺序（复用现有机制）

规则表 → 信任缓存 → Jev。这是 B 模式成本可控的关键：常用安全调用被 allow 规则/信任缓存短路后**不发 HTTP**。审计行「加白」按钮在 review 记录上同样可用（一键把已批准调用存成 allow 规则）。

### 3.5 deny 语义（已拍板：fail-closed，不转人工）

- **reject → `{kind:"deny"}` 直接拒绝，body 不执行**；`unavailable`/`cancelled`/低置信（阈值下）**同样按拒绝**——审查模式下没有任何人工兜底，与插件「风险即拒绝 / fail-closed」哲学一致（与官方 auto 的"deny 回退人工"刻意不同）。
- 拒绝的工具结果带结构化 detail（对齐官方 deny 卡片形态）：`{ name: "AgentReviewDeniedError", code: "AGENT_REVIEW_DENIED", reason: <Jev 风险理由> }`，正文注明 body 未执行；理由照常进审计。
- 预设 spec 的 `approval: ask` 仅是预设档位要求（preset 必填 ask/never；ask 保证 `approval/request` 瀑布与其他预设语义一致），**不代表拒绝会问人**。
- 误杀治理靠三层降噪而非人工兜底：规则表短路、信任缓存、Jev 低置信对称门控（低置信记 `unavailable` 而非 reject，但调用仍不执行）。若实测误杀率不可接受，二期再加「拒绝后转人工」开关（列为 future，不在本期）。

### 3.6 与现有 `agent-approval` 模式的关系

- `_enabled` 条目扩展 `mode: "escalation" | "review"`，两模式**互斥**（同一会话一个 preset）。
- review 模式会话下 `approval/request` 瀑布仍挂现有监听器：以 review 模式开启的会话**不接管**人工审批（`_onApprovalRequest` 只对 mode==="escalation" 的会话裁决，其余 `next()`）——避免双层裁决与语义混乱。
- 预设联动沿用第 8 节机制：选中 `agent-review` → `_enableCore(mode:"review")`（记住 prev 旋钮）；切走 → 恢复 prev 旋钮 + 清 bookkeeping/信任缓存。命令：新增 `/agent-review on|off`（commands.register，与 `/agent-approval` 对称）。

### 3.7 审计与 UI

- 同一旁路文件 `<sessionDir>/agent-approval.jsonl`，entry 新增 **`mode: "escalation" | "review"`** 与 **`via`（`rule`/`trust`/`jev` 短路来源，现有 model 列已有 rule/trust 可复用，不加 via 也可）**；`mode` 为必填新字段 → **严格 schema 三处同步**（index.js 构造、typert.host.js、client.js 展示），旧记录缺失 mode 时 client 显示为 escalation（容错）。
- 「审批」tab：review 记录行工具列标 `（逐调用）` 徽标；倒序、悬停、加白按钮全部复用。
- 量级：逐调用全量记录（可回放性优先），文件增长快于现状——`sessionRecords` 已按 `at` 正序读，渲染无瓶颈；降噪开关（只记拒绝+短路命中）已拍板列为二期（本期全量）。

### 3.8 生命周期

| 事件 | 行为 |
|---|---|
| 开启（菜单/命令） | gate 校验 → 记住 prev 旋钮 → 写 `permission/preset: agent-review` + 旋钮（danger-full-access + ask，经规范 setter）|
| 关闭/切走 | 恢复 prev 旋钮（规范 setter，no-op 检测）；清信任缓存与 bookkeeping |
| 会话 disposed | 同现有清理点 |
| 重启恢复（`agent/created` 折叠 preset 事件） | 折出 `agent-review` → 重新以 review 模式启用；**gate 不过则 fail-closed 回退 agent-approval 预设**（绝不恢复 Full access 裸奔）。该监听器 0.1.7 起是 `@mode serial`，绝不抛错/返回 Promise（现有约定）|
| 插件卸载/模式关闭时在途裁决 | lifecycle abort + 等待结清（参照官方 dispose 骨架） |

### 3.9 代码落点

| 文件 | 变更 |
|---|---|
| `index.js` | 输出指令尾巴参数化（`_judgePrompt`/persona 复用零改动）、`_judgeWithLlmStream`、`judgeMode` 分支（默认 llm / 可选 subagent）、`_onPreExecute`、`_reviewMaterials()`（B 专用）、`_enableCore` 分 mode、`agent/created`/`permission/preset` 联动扩展、`/agent-review` 命令、gate 校验 |
| `typert.host.js` | record schema 加 `mode`；`getState` 加 `judgeMode`/`reviewAvailable`；`setJudgeMode`（或并入 `setModel`）；全部 codec 双格式 |
| `client.js` | 「裁决方式」下拉（LLM 直连默认 / 隔离子代理）；设置页加「逐调用审查（实验）」区块（gate 说明 + fail-closed 语义说明）；菜单行隐藏 observer；审批 tab mode 徽标；显示名改名同步（见 3.10） |
| `cordis.patch.yml` | 预设表整行重述 + `agent-review` |
| `AGENTS.md` | 新增「LLM 直连裁决（默认）」「逐调用审查模式」两节 + 验证清单 10/11/12 条；存量验证条目里「Agent 审批」字样随改名同步 |

### 3.10 显示名改名：「Agent 审批」→「自动审批」（全部用户可见文案统一）

**范围**（已拍板）：`/permission` 菜单行、输入框权限触发按钮、设置页侧栏与标题全部改「自动审批」；README/AGENTS.md 用户可见文案同步。**不动**：包名、`exports`、`/agent-approval on|off` 命令、preset key `agent-approval`、wire 描述符 id、审计记录字段。

**实施期的坑（必须处理，否则图标静默失配）**：client.js 的两个图标 observer 都是**按显示文本匹配**的 MutationObserver——

- `registerPermissionGlyphIcon(...)` 匹配 `/permission` 菜单行与输入框触发按钮里"文本等于 label"的元素；
- `registerSettingsNavIcon(...)` 匹配设置侧栏里"文本等于 section label"的按钮。

现在这两处拿 `SETTINGS_LABEL`（"Agent 审批"）同时匹配菜单行文本和设置页 label，靠的是 preset `name` 与设置 label **碰巧同名**。改名落地要求：

1. `SETTINGS_LABEL` 改为 `"自动审批"`（单一常量继续驱动两处匹配——菜单 preset `name` 与设置 label 保持同名，这个巧合约定要写进 AGENTS.md 警示后人）；
2. `cordis.patch.yml` 的 `agent-approval` 预设 `name: 自动审批`（触发按钮与菜单行显示源）；
3. 新预设 `agent-review` 的 `name: 自动审查`（gate observer 匹配文本同步）；
4. 本地开发如跑过 `scripts/patch-glyph.mjs`（历史脚本），注意它硬编码旧文本——标准安装不执行它，但别在改名后误跑。

随阶段 3 一并实施；验证清单第 12 条覆盖。

---

## 4. 决策点（已拍板 ✅）

| # | 问题 | **结论** |
|---|---|---|
| 1 | review 模式 reject/失败后 | ✅ **直接拒绝（fail-closed），不转人工**（「拒绝后转人工」开关列为 future） |
| 2 | pre-execute 覆盖面 | ✅ **native + PTC inner**（排除 outer run_code，对齐官方） |
| 3 | Jev 低置信（阈值下）在 review 模式 | ✅ **按拒绝处理**（审计记 `unavailable`，调用不执行） |
| 4 | 新预设命名 | ✅ `agent-review` / 「自动审查」 |
| 8 | （新增，用户指示）显示名改名 | ✅ 「Agent 审批」→「**自动审批**」，全部用户可见文案统一（菜单/触发按钮/设置页）；代码标识（包名、`/agent-approval` 命令、preset key、wire id）不动 |
| 5 | 审计粒度 | ✅ **全量逐调用记录**，二期再加降噪开关 |
| 6 | LLM stream 后端是否也做 review 模式裁决器 | ✅ **本期不允许**（gate 只认 Jev）；回退裁决器列为 future |
| 7 | （新增，用户指示）功能 A 形态 | ✅ **LLM 直连为默认裁决方式**（输入/输出与 subagent 同构、仅调用方式不同）；不启动 subagent 以消除上下文污染；spawn 保留为可选「隔离裁决」方式 |

## 5. 兼容性与风险

- **DSH 0.1.7-rc.2 契约**：`tools/pre-execute` 的 exec/返回值形状以官方 auto-review 消费代码为权威参照（`{kind:"allow"|"deny"|"ask"|"cancel"}`）；开发期对 `exec` 字段做一次实证冒烟再定稿实现。codec 双格式与 `npm run check` 照旧。
- **双层冲突**：与官方 experimental-auto-review 同装且同会话开启时，`tools/pre-execute` 上会叠两层 prepend（auto 与我们的 review），裁决口径与审计互不知情——README/设置页明示**不要同开**。
- **Full access 风险面**：review 模式是 Full access 语义——Jev 漏判即执行。gate Jev、规则表/信任缓存短路是为此兜底；**deny 一律 fail-closed 不转人工**，误杀治理靠短路降噪（Jev 中文准确率打折是已知误杀来源，实测不可接受再上二期"转人工"开关）。设置卡片明示实验性质（对齐官方 EXP 口径）。
- **Jev 已知限制沿用**：中日韩文本准确率打折、速率限制变化均归 fail-closed（或转人工）。
- **preset 表整行重述**：DSH 升级改基础表需手动同步（现约定）；key 避开保留字 `auto`/`custom`。
- **性能**：逐调用一次 Jev HTTP（亚秒级）+ 短路命中零开销；不用 spawn 子代理是 B 成立的前提。
- **版本声明**：无需改 `engines.dsh`/peer 范围（0.1.7-rc.2 仍在 `^0.1.5-rc.3` 内）；发 v1.8.0。

## 6. 实施步骤

1. **阶段 1（A，独立交付）**：输出指令尾巴参数化（零行为变化）→ `_judgeWithLlmStream`（复用 `APPROVER_PERSONA` + `_judgePrompt` + `VERDICT_SCHEMA` 等价校验，含流聚合 + fail-closed）→ `judgeMode` 设置项 + wire 三处 + `npm run check` → 端到端冒烟（验证清单 10，含"零子会话"核验）。
2. **阶段 2（B 核心链路）**：`_onPreExecute` + Jev 裁决 + 规则表/信任缓存短路 + deny 语义 + 审计 mode 字段。
3. **阶段 3（B 集成面）**：`agent-review` 预设 + gate 三层 + 菜单 observer + `/agent-review` 命令 + 重启恢复 + 联动兜底。
4. **阶段 4**：验证清单全跑 + AGENTS.md/README 更新 + 发 v1.8.0。

## 7. 验证清单（追加到 AGENTS.md「开发/验证」）

10. （功能 A）**默认即 LLM 直连**：开启 agent-approval 后触发一次提权 → 亚秒级裁决、审计 model 列 `llm(<provider>/<model>)`、`childSessionId` 空，且**会话列表不出现审批员子会话**（零上下文污染核验）；裁决方式切「隔离子代理」→ 恢复旧行为（子会话出现、childSessionId 有值）；模型路由指向不存在的模型 → `unavailable`；超时调 30s + 大上下文 → `unavailable`；规则/信任短路照常（不发 LLM 请求）。
11. （功能 B）设置页启用 Jev 后，`/permission` 菜单出现 **自动审查**；未配 Jev 时该菜单行不可见、`/agent-review on` 报错；选中后触发一次普通工具调用 → 不打断、执行前经 Jev 一次（审计 tab 出现 mode=逐调用 记录）；高危调用（如删工作区外文件）→ **直接拒绝、body 不执行**（工具结果带 `AGENT_REVIEW_DENIED` detail），**不弹人工**；低置信/超时/路由故障 → 同样直接拒绝并记 `unavailable`；同参数再调 → trust 短路；关掉 Jev 配置后重启 → 会话回退 agent-approval 预设（不裸奔 Full access）；切回 workspace-write 预设 → 旋钮恢复、不再逐调用审查。
12. （改名）`/permission` 菜单第四项显示 **自动审批**（不再是 Agent 审批），输入框权限触发按钮同步显示 **自动审批**，设置页侧栏出现 **自动审批** 页；菜单行盾牌图标与设置页 shield 图标照常显示（文本匹配 observer 同步过，无静默失配）；`/agent-approval on|off` 命令仍可用（命令名不动）。
