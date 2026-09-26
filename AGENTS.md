# AGENTS.md — dsh-agent-approval

面向 AI agent 与协作者的开发指南。**读这里再动手**，尤其"关键机制"和"重要注意事项"，记录了本项目踩过的大量坑。

## 项目是什么

一个 **DeepSeek Harness（DSH）双面（Host + Client）插件**：新增一种 **自动审批** 权限模式。

- 以 **workspace-write 为基线沙箱**；工具请求提权（更宽沙箱，如 `sandbox_permissions`）时，不再弹人工审批，而是交由**一个独立的审批 Agent（subagent）裁决**。
- 审批 Agent 在**独立会话**里运行：零父级上下文、全局工具全部空白（`toolFilter: {allow:[]}`）、审批策略被委派机制钉死为 `never`（不可能递归再审批），必须通过 `structured_output` 结构化工具给出裁决：`{ decision: approve|reject, riskLevel, rationale }`。
- **风险即拒绝**：破坏性 / 不可逆 / 越界 / 理由与实际参数不符 → `reject`；只有"安全、可逆、与任务相符、理由诚实"才 `approve`。
- **Fail-closed**：审批 Agent 启动失败、超时、结果不合法、请求被取消 → 一律按拒绝处理（`unavailable`/`cancelled`），绝不静默放行。
- **设置面板**新增 **自动审批** 页（`settings.section`）：配置审批模型（provider/model、Harness 默认模型，或 **TypeSafe Jev 直连后端**，见第 4b 节）与审批超时（两者**持久保存**，重启不丢）、查看已开启会话（chip 显示**与会话列表同源的标题**（Host 侧经可选服务 `sessionTitle` 折叠，缺席降级为空串）+ 短 id，悬停看完整会话 ID 与工作区 cwd；`getState` 的 `enabledSessions` 为 `{id,title,cwd}[]`，client 兼容旧 Host 的 `string[]` 形状）、**放行/拒绝规则表**（deny/allow 规则先于模型短路，持久化）。**审计不在这里**：会话窗口顶部新增**「审批」标签页**（`conversation.view` ring，紧邻「轨迹」；chat=0 / trajectory=10 / 审批=11），按会话折叠展示审批记录（**倒序、最新在上**；结论/风险/模型/耗时/理由，悬停看完整理由与工具参数，行内可一键「加白」）——记录存在**会话目录内的独立旁路文件**（见第 6 节）。
- 输入框 `/permission` 菜单的「自动审批」预设 + `/agent-approval on|off` 命令为当前会话开关（**刻意没有 composer chip**——开关本就属于权限菜单，菜单旁边再放一个属冗余，已移除）；关闭时**恢复开启前的权限旋钮**（沙箱模式 + 审批策略）。

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
- **codec 双格式（v1.7.0，两代 Typert 契约并存）**：manifest 与 client 描述符的每个 codec/result **必须同时**带 `schema` 与 `create: () => schema` 两个字段（指向同一 schema 对象）——DSH ≤0.1.5-rc.3 的 typert-loader 校验 `"_zod" in schema`、client registry 校验 `schema.parse`，而 DSH 0.1.7-rc.1 起两侧都改校验 `create()` 工厂（"has no create() factory" 直接拒绝注册：Host 侧 Remote 全挂、Client 侧 `$mount` 抛错让整个 bundle 的 apply 失败）。改 wire 形状后必须跑 `npm run check`（内含 `scripts/check-typert-manifest.mjs`：镜像两代校验器 + 从真实 client.js 提取描述符做 id/参数/typeSymbol 对齐）。

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

### 4. 审批裁决：一次性 `spawn` 子代理 + 结构化裁决（v1.8.0 起为可选的 `judgeMode: "subagent"` 路径；**默认裁决器是 LLM 直连，见第 11a 节**——本节的输入/输出契约两路完全同构）

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
- **给审批员看的材料**：从会话日志按 `callId` 倒查 `tool/call` 事件的 `arguments` 原始 JSON（**精确命令**，不是转述）、`req.reason`（工具方的提权理由）、workspace cwd、以及**首条真实用户消息（原始任务陈述）+ 最近 3 条真实用户消息**（`user/message` 且 `source.kind === "user"`，每条截断 800——任务的 ground truth；短会话里首条已在最近列表中则去重）。审批提示词明确 APPROVE 四条件与 REJECT 清单；v1.4.0 起**删除"存疑即拒"**——拒绝必须能指出该操作的**具体可信风险点**（毁什么/泄什么/越什么界），笼统不确定、没见过的命令、简略的理由都不是拒绝理由（误杀治理，见第 5 节规则表）。
- **审批员自身约束消歧（v1.3.5 修复的真实误杀）**：审批员子会话被委派机制钉死 `approval/policy: never`，harness 会向它注入运行时上下文 "Approval prompts are disabled in this session…"。小模型（flash）曾把这句**关于审批员自己**的约束误读为**请求方会话**的属性，两次以此为由拒绝了本该批准的操作（见 records.jsonl 2026-08-21 / 2026-08-22 两条 rejected）。因此 persona 与提示词都显式声明："你自身的 never 策略与固定作用域只约束你自己，绝不可作为请求方会话的属性或拒绝理由"。改提示词时**不要删掉这句**。
- **裁决一致性口径**：判"操作 vs 用户任务"的**客观对齐**，不依赖请求方理由的措辞水平——理由只是辅助证据：操作本身明显安全且与任务相符时，理由写得简略**不拒**；但理由与实际参数造假/不符仍**照拒**（读过审核标准的 agent 不能靠文笔获得优待）。
- **开发流程口径**（端到端任务不被卡死的关键）：提权档位只有粗粒度两档，审批员**判实际操作而非档位名**——项目自带的安装/构建/部署脚本写其文档指定的安装路径（如工具自身 profile 目录）、覆盖自身已安装的文件（可从源码再生成）、读调试所需的工具自有配置/日志，都算"任务明确所需"可 approve；但**修改操作系统或其他应用的数据**仍一律 reject。

### 4b. TypeSafe Jev 直连判定后端（v1.6.0 起）

设置页 Provider 选 **TypeSafe Jev**（合成 provider id `typesafe`，**不在** `llm.listProviders()` 目录里——Jev 是 "System One" 决策模型，不是聊天路由，不能走 Harness 模型注册表）。`_model.provider === "typesafe"` 时 `_judge` 在规则表/信任缓存短路之后直接走 `_judgeWithJev`，**不 spawn 子代理**：

- **协议**：POST `<endpoint>`（默认 `https://api.typesafe.ai/v1/systemone`，可配第三方网关），`Authorization: Bearer <key>`，body = `{ state, model, questions }`。Key 来自 config.json 的 `jev.apiKey`（明文，本机文件）或环境变量 `TYPESAFE_API_KEY`（留空时回退）；两者都缺 → 判定直接 `unavailable`（fail-closed）。`fetch` 用 Node 全局，**无新 npm 依赖**。
- **state**（`_jevStateOf`）：workspace / tool / statedReason / toolArguments（4000 截断）/ firstUserMessage / recentUserMessages——与子代理提示词**同一份 ground truth**（复用 `_recentUserContext`）。
- **questions**（`JEV_QUESTIONS` 常量）：`decision` = Choice(approve/reject，**策略全部写进 criteria 描述**——Jev 按字面读指令、领域知识只能进 state+criteria)；`riskLevel` = Choice(low/medium/high)；`concreteRisk` = Noul（"是否存在具体可信风险"辅助信号，只进审计理由）。措辞口径与子代理提示词一致（含开发流程口径与误杀治理）。
- **置信度门控**：`decision.confidence < 阈值`（默认 0.5，可配 0.01–0.99）→ `unavailable`——**对称适用**：低置信的 reject 也不记拒绝（v1.4.0 误杀治理的对称版："模型没把握就不裁决"）。
- **结果映射**：approve → `allowed-once`（写信任缓存）；reject → `rejected`；任何畸形返回 / 非 200 / 传输故障 / 超时 → `unavailable`；取消 → `cancelled`（AbortController 联动 `req.signal`，同一 `this._timeoutMs` 竞速，`finally` 里无条件 abort 掉传输）。
- **审计**：model 列 `jev(<served version>)`——响应体 `model` 字段会解析别名（请求 jev-latest → 记 jev-1.13.0）；理由列由概率分布合成（**Jev 不生成文字**，没有自然语言推理可记；v1.7.2 起同时含**风险轴**的置信度与 `p low/medium/high`——`riskLevel` 与 `decision` 是两条独立问题，**risk=high 不改变 outcome**，但审计理由必须能看出 high 的把握度，字段缺失只省略、绝不改变校验门槛）；`childSessionId` 为空（没有子会话）。
- **wire 同步**：`setJevConfig` invocation（index.js `markRemoteMethod` + typert.host.js `jevConfigSchema`/invocation/`AgentApprovalJevConfig` 等类型 + client.js 描述符）；`getState` 带 `jev` 字段，client 对旧 Host 缺该字段时保留空草稿降级（saveJev 还有 `typeof remote.setJevConfig === "function"` 守卫）。
- **已知限制**（设置卡片已注明）：Jev 官方声明中日韩文本"可处理但准确率较低"（审批 state 里的中文任务上下文会打折）；early access 阶段速率限制可能变化——所有异常都归 fail-closed，不会误放行。

### 5. 规则表与会话内信任（v1.4.0 起，先于模型裁决）

提权进入 `_judge` 后按固定顺序短路，全部**零模型开销、零人工弹窗**：

1. **deny 规则命中 → 直接 `rejected`**（所有 deny 先于任何 allow 判定，后加的 deny 永远压过先加的 allow）；**allow 规则命中 → 直接 `allowed-once`**。规则形状 `{ id, effect, tool, match, note, createdAt }`，持久化在 config.json 的 `rules` 字段：`tool` 为精确工具名或 `"*"`；`match` 为空 = 该工具全部调用，否则是**参数原始 JSON 的子串**或 `/pattern/flags` 正则（`_ruleRegex` 编译失败 = 永不命中，`addRule` 时即校验拒绝）。规则命中也写审计（model 列记 `rule`）。
2. **会话内信任缓存**：模型 approve 后把 `工具名 + "\n" + 参数原始 JSON` 指纹存入该会话的 Set（`_trusted` Map）；同一会话内**参数逐字节相同**的再次提权直接 `allowed-once`（审计 model 列记 `trust`）。**不跨会话、不泛化到相似参数**，随 `_enabled` 条目一起在三处删除点清空（preset 切走 / session disposed / `_disable`）。跨会话复用走规则表：会话窗口「审批」tab 审计行的「加白」按钮一键把已批准操作存成 allow 规则（记录里的 args 是完整参数 JSON 的**前缀**，截断标记 `…[truncated]` 需先剥掉）。
3. 都不命中才进裁决器（v1.8.0 起默认 **LLM 直连**，见第 11a 节；Jev / 隔离子代理见第 4b / 4 节）。**规则/信任短路对自动审查模式（第 11b 节）同样生效**——这是逐调用审查的成本控制关键。

- 设置页「放行 / 拒绝规则」卡片管理规则（Remote 方法 `addRule`/`removeRule`，整表返回；`getState` 带 `rules` 字段，client 对旧 Host 缺该字段时降级为 `[]`）。
- wire 变更照旧三处同步：index.js 构造、typert.host.js（`ruleSchema` + `rulesValueSchema` + 两个 invocation + `AgentApprovalRule`/`AgentApprovalRulesResult` 类型声明）、client.js（描述符 + UI）。

### 6. 审计记录（v1.5.1 起：会话目录内的独立旁路文件）

- 每条裁决由 Host `_record(session, entry)` 追加到**请求会话自己存储目录里的旁路文件** `<sessionDir>/agent-approval.jsonl`，目录经 `sessionPersistence.locate(session.header)` 解析（纯路径计算，活会话可用；返回 `{kind:"jsonl", path:<session.jsonl.zstd 绝对路径>}`，取 dirname）。定位失败降级为 `<DSH_HOME>/agent-approval/records/<sessionId>.jsonl`（重启仍安全，但删会话不随删）。语义上仍是"跟随会话保存"：随会话目录存在，删除会话即消失。
- **绝不要把审计写进会话事件日志（v1.5.0 的方案，半天即废弃）**。踩坑全过程：`dsh-session` 的 `append()` 运行时不校验事件类型枚举，`dsh-session-persistence-jsonl` 也按原样回放——但 **`dsh-session-persistence` seam 在加载时强制校验**：`KNOWN_SESSION_EVENT_TYPES` 之外的类型，事件信封必须带 `ignorable: true`，否则**整个日志拒绝加载**（"refusing to interpret"）。而活会话的写入口 `session.append(type, data)` 只接受 type/data/surface 元数据，**给不了 ignorable 标记**（类型签名也限死 `SessionEventType`）——所以一条审批记录就会让该会话永远无法恢复。另外日志压实（compaction）也可能丢弃 ignorable 外部事件。
- **"v1.5.0 零写入"的旧结论是假的，2026-09-06 已证伪并修复**。旧版 `check-session-log.mjs` 用朴素 magic 扫描切帧且带占位符 bug，只解出部分帧就报"零写入"——实际 session-886106a4 的日志里有 **3 条**未标 ignorable 的 `agent-approval/record`（seq 52022/117810/140809），会话历史加载被拒。注意官方机制本就给插件事件留了正门：`dsh-session` 的 `known-event-types.js` 明说 **`ignorable` 标记就是 repo 外插件事件的兼容机制**（只是 `session.append` 的活写入路径给不了它）。修复用 `scripts/repair-session-log.mjs`：按 `scanZstdFrames` 的结构化走帧（逐 block header 前进，不靠帧头 content size），**只给 3 个事件的信封补 `"ignorable":true` 并重压所在帧，其余帧字节不动**——绝不能删行，扫描器强制 seq 连续（`event.seq !== events.length` 即 seq gap）。写前快照 mtime/size 防并发写、写前备份、写后全帧解码验证。校验/扫描用重写后的 `check-session-log.mjs`（可 `import { auditLog }` 库用；注意 `text-chunks`/`reasoning-chunks`/`tool-call-chunks` 是存储行、`type:"session"` 是头记录，都不进事件类型校验；`zstdDecompressSync`/`createZstdDecompress` 对多帧拼接文件只会解出第一帧，必须逐帧解）。全库 194 个日志复扫，仅此一个会话中毒。seq 140809 写于 12:27:59（"重启"之后）——说明当时仍有旧构建的 Host 半在写日志；现装 v1.5.1 已验证只剩 `permission/preset`/`sandbox/mode` 两种已知类型的 `session.append`。
- **最终裁定（2026-09-06，用户明确）**：zstd 会话日志里**不存、不读任何插件自定义数据**。v1.5.2 起 `sessionRecords` **只读旁路文件**（v1.5.1 的"防御性日志折叠"已删除，`RECORD_EVENT` 常量一并移除）。日志中遗留的 3 条 ignorable record 事件（seq 52022/117810/140809）为惰性历史，加载已验证安全；**物理删除不可行**——删行会破坏 seq 连续性（扫描器以 `event.seq !== events.length` 判 gap），修复需全日志重编号，风险远大于收益，不要尝试。
- 读取：Host `sessionRecords({ sessionId })` **只读旁路文件**（`_recordsFileOf`），按 `at` 正序返回，同时带 `enabled`（该会话当前是否开启）。Client「审批」tab 挂载 + 每 10s 轮询（tab 未激活时不渲染、不轮询）。
- 每条：时间、会话、工具、结论、风险等级、审批模型、耗时、理由（截断 600）、`childSessionId`（审批 Agent 自己的会话短 id——在会话列表里能找到完整推理记录）。
- **追加必须吞错**：`_record` 是 fire-and-forget 且全链 try/catch——审计失败绝不影响审批主流程。没有"清空记录"：随会话存储的事实源，且权威审计（`approval/asked`+`approval/decided` 事件对）本就不归我们管。
- **v1.4 → v1.5 迁移**：`scripts/migrate-records.mjs`（`--dry-run` 可预览）把旧全局 `records.jsonl` 按短 sessionId（UUID 前 8 字符）匹配到 `~/.dsh/sessions/<workspace>/<session-id>/`，追加写入各会话的 `agent-approval.jsonl`（幂等去重），最后把旧文件改名为 `records.jsonl.migrated` 防止重复迁移。历史 bug 行（`sessionId` 为字面 `"session-"`）无法归属，直接跳过。本机已迁移：157 条 → 8 个会话，56 条无法归属。
- **必须整形状构造**（`typert.host.js` 的 result schema 是 strict）：每个字段都在、类型正确，数组用 `.readonly()`。新增字段要同步改三处（index.js 构造、typert schema、client 展示）。
- **短 id 切片必须跳过 `session-` 前缀**：DSH 的 sessionId 是 `session-${randomUUID()}` 格式（见 `dsh-host-apiproxy/lib/index.js` 的 `session create`：`session-${randomUUID()}`），前缀正好 8 字符，`String(id).slice(0, 8)` 只会切到那个无意义的前缀——历史 bug：所有审计行的 `sessionId` 全是 `"session-"`，已开启会话 chip 显示也是。Host 的 `shortId()` / Client 的 `shortSessionId()` 都必须先 `id.startsWith("session-")` 剥掉前缀再取 8 字符；`childSessionId` 来自 `run.id = randomUUID()`（无前缀），同一函数兼容。**不要**改回 naive slice——会再次触发。

### 7. Client 半：bundle 格式

- 必须 `window.__ModuleLoader__.load({ id, factory })`，`exports.inject = ["slots", "remote"]`。
- **按钮一律用官方 Button 原子**：`const ui = require("@deepseek-ai/dsh-client-ui-primitives")`，`h(ui.Button, { variant: "primary"|"ghost"|"outline", size: "sm", onClick }, "…")`。自定义 `.aapr-btn` 按钮样式已移除——它不跟 `--dsw-alias-button-*` token 家族，深色模式下难看（与 dsh-memory-manager 踩过的同一个坑，同一个修法）。
- **Remote 命名空间必须自挂载**：`await ctx.remote.$mount(CLIENT_REMOTE)`（dsh-api-remotes 只挂载官方命名空间），然后 `ctx.get("remote.agentApproval")`。描述符与 `typert.host.js` 的 invocation 一一对应；浏览器没有 zod，用 passthrough schema（`{ parse: (v) => v }`），且每个 codec 同时携带 `schema` + `create: () => schema` 双格式（见第 1 节 codec 双格式；0.1.7 起 `$mount` 校验 `create()`）。
- **返回值双层信封**：gateway 返回 `res.value` = Host 方法的 `{ ok, value }` 信封，client 的 `pick()` 做容忍双形状解包 + 双层错误上抛（token-stats 踩过"多包一层"的坑）。
- **CSS 注入**用 `document.createElement("style")` + `ctx.effect(() => () => styleTag.remove())`；样式一律用 `--dsw-alias-*` 主题变量。
- 两个 Slot：`settings.section`（id `agent-approval`，order 30，label `() => SETTINGS_LABEL`）+ `conversation.view`（id `agent-approval-audit`，**order 11**——chat=0、trajectory=10，紧邻轨迹；label `() => "审批"`）。conversation.view 是 **session-scoped list slot**：组件经标准 kit 拿到 `useSession` hook，`useSession((s) => s)` 的快照读 `sessionId` 叶子字段即可，无需 inject；组件只在 tab 激活时渲染（`renderSlot(..., { only: active.id })`），轮询因此零闲置开销。tab 栏渲染条件是 `tabs.length > 1`，注册即出现。曾有过 `conversation.input.left` 的「🛡 审批」chip（id `agent-approval-toggle`，order 15，InputZone owner props 传 `props.session`，只读 `sessionId` 叶子字段），已移除——开关本就属于 /permission 菜单，菜单旁边再放一个开关是冗余。
- **设置导航图标**：DSH 0.1.x 的 `settings.section` 只投影 `id/order/label`，设置壳对每个外部 section 统一画通用齿轮（`client-ui-settings-general` 的 `navIcon()`，没有公开图标字段）。client.js 里 `registerSettingsNavIcon(SETTINGS_LABEL)` 用 MutationObserver 给 `[role="dialog"] nav button` 中文本等于 section label 的行打 `data-dsh-agent-approval-settings-nav` 标记，CSS 再隐藏 `>svg:first-child` 齿轮、用 `currentColor` mask 画 shield-check Lucide 图标（16px，跟随原生 hover/active 颜色）。换图标只需替换 CSS 里 data URI 的 SVG path（Lucide，24×24，stroke-width 2，stroke 用 black——mask 只取 alpha）。
- client.js 里**不要用 `?.` / `??`**（与 token-stats 保持一致的保守写法），用 `&&`/`||`；不要 `import`，用 `require("react")`。

### 8. 权限菜单集成（`permission` 行覆盖 + `permission/preset` 事件联动）

权限菜单（输入框 `/permission` 控件）的选项来自 **`dsh-permission-presets` 的 Config 预设表**；Web 端切换 = 执行 `/permission <preset>` 命令 → 追加 `permission/preset` 事件 + 旋钮事件。要让「自动审批」出现在菜单里：

1. **包的 `cordis.patch.yml`（bundle patch）里写 `- id: permission` 覆盖行**，把 `agent-approval`（bundle = workspace-write + ask）加进预设表。**patch 语义是整行替换 config（不合并）**，所以必须重述全表（read-only / workspace-write / **agent-approval** / danger-full-access）——**声明顺序即菜单顺序**，agent-approval 排在 Full access 上面；DSH 升级若改了基础表要手动同步。
2. **菜单图标（v1.3.2+ 由插件内置，无需 patch）**：菜单行 + 触发按钮的图标来自编译进官方 `dsh-client-ui-conversation` 的硬编码映射 `permissionGlyphs`（源码注释明说 "host-configured names outside the design set get none"），**没有公开注册口**，外部预设整行不渲染图标元素。client.js 的 `registerPermissionGlyphIcon(SETTINGS_LABEL)` 用 MutationObserver 给「自动审批」的 `/permission` 菜单行（`[role="menu"] button[role="menuitem"]` 中文本等于 label 者）和输入框旁触发按钮（非 menuitem、不在 `[role="dialog"]` 内、首 span 文本等于 label 且含 svg 者）分别打 `data-dsh-agent-approval-perm-item` / `data-dsh-agent-approval-perm-trigger` 标记，CSS 再用 `currentColor` mask 画盾牌 + AI 星形（16×16，与出厂图标同风格）。**菜单行有 glyph-set 守卫**：只在"兄弟行已带官方图标"的菜单里打标——判定为菜单内存在 `span[class*="itemIcon"]`（v1.7.0 从 `_itemIcon_` 放宽：CSS-modules 两代编译名不同（`_itemIcon_<hash>_` vs `<hash>_itemIcon`）；选中行的对勾是 `_check_`，不会误判）。0.1.7-rc.1 起权限控件从 dsh-client-ui-conversation 拆到独立包 `dsh-client-ui-permission-presets`（composer 里挂 `conversation.input.permission` slot，`PermissionSelect` 已从 conversation 包删除），但菜单仍是同一 Menu 原语（`button[role=menuitem]` + itemIcon span），标记逻辑不变。设置页 → 通用 → 「权限」行的默认预设下拉（`Menu portal:true` 传送到 `<body>`，所有预设都无图标）因此**不再**被误标——否则「自动审批」会成为那里唯一带图标的行。历史方案 `scripts/patch-glyph.mjs`（直接补丁官方编译产物）已被取代——插件内置版随包分发、DSH 升级不丢；脚本保留作参考，新安装**不再需要**跑它。
3. **同 bundle 歧义规则**：`agent-approval` 与 `workspace-write` 的旋钮值完全相同；`derive()` 里"仍匹配的最后选中预设"赢得平局，所以**菜单显示什么完全由最后的 `permission/preset` 事件决定**。因此：命令开启时也追加 `permission/preset: agent-approval`（菜单同步显示）；命令关闭时按恢复的旋钮值回写正确的预设事件（跳过我们自己的条目），否则菜单会卡在「自动审批」。
4. **事件联动**（`session/event` 监听 `permission/preset`）：
   - 选中 `agent-approval` → `_enableCore`（此刻旋钮事件还没落，捕获的 prev 恰是切换前的值；我们写的旋钮值与预设服务随后要写的相同，它检查后跳过，无重复事件）。
   - 选中其他预设 → 只删 bookkeeping，**不恢复旋钮**（预设服务马上写自己的旋钮，恢复会打架）。
5. **跨重启存活**：`agent/created` 监听在（重）发布时折叠日志——`permission/preset` 折出 `agent-approval` 就重新启用。spawn 的审批员子会话不带 preset 事件（无 seed），不会递归重启用；fork 子会话 seed 里可能带父级的 preset 事件 → 会继承该模式（有意语义：模式跟随会话的工作；"later child switches win" 是官方允许的后来者覆盖）。
6. **防御**：`_presetRegistered()` 先确认表里有 `agent-approval` 才追加 preset 事件——没装覆盖行时，追加会被会话不变量（unknown preset）直接抛错。
7. **宿主 Session API 兼容（v1.4.2 修复的真实故障）**：DSH 0.1.2-rc.1 **删除了 `session.events` 公开快照数组**，改为 `snapshotEvents(from?, to?)` / `eventAt(seq)` / `seq`。插件所有日志折叠（`_lastKnob` / `_callArgsOf` / `_recentUserContext`）必须走 `_eventsOf(session)`（新 API 优先，legacy 数组兜底）。0.1.1→0.1.2-rc.1 升级后的症状极具欺骗性：监听器 try/catch 把 TypeError 吞掉，`_enableCore` 静默失败，没有任何会话能进入 `_enabled`，于是每个提权都 `next()` 落回人工弹窗——看起来"插件在运行但就是不审批"。**改任何读日志的代码前先确认没用裸 `session.events`。**
8. （已随 composer chip 的移除而作废）曾有的 chip 每 10s 轮询一次 enabled 状态；若未来重加 chip，注意 InputZone 的 ConversationSnapshot **没有** projections 字段，读不了 `permissions` 投影，只能轮询。

### 9. 标准安装 = dsh bundle（package.json 声明 + 包内 cordis.patch.yml）

本插件是**标准 DSH bundle**：`package.json` 的 `dsh.bundle.patch` 指向包内 `cordis.patch.yml`，用官方 `dsh plugin` 命令安装：

1. `dsh plugin --profile web add <本地路径或包>`：pnpm 把插件装成 profile 的 npm 依赖（本地路径走 `link:` 软链，改代码即生效），并把包名追加到 profile `package.json` 的 `dsh.profile.bundles`。**`link:` 安装的前提：插件目录里必须已经 `npm install` 出 `node_modules`**——loader 从链接的**真实路径**加载 `index.js`，其裸导入（`@deepseek-ai/cordis`、`@deepseek-ai/dsh-typert-protocol`、`zod`）从插件自己的 `node_modules` 解析；缺了会在启动时 `ERR_MODULE_NOT_FOUND`，**整个 DSH 起不来**（2026-08-27 实踩）。对齐宿主版本避免双副本漂移：`npm install --no-save --registry=https://registry.npmjs.org @deepseek-ai/cordis@<宿主版本> @deepseek-ai/dsh-typert-protocol@<宿主版本> zod@^4.4.3`（宿主版本从桌面安装目录的 `.pnpm` 仓查）。
2. 启动时 DSH 应用包内 `cordis.patch.yml`，做两件事：**`- insert:`** 新增插件挂载行（**不要**对不存在的 id 用普通 `- id:`，会报 "entry not found"）；**`- id: permission`** 覆盖预设表行（该 id 已存在，覆盖合法）：

```yaml
# cordis.patch.yml（随包分发，节选——以包内实际文件为准）
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
        name: 自动审批
        description: workspace-write base; every sandbox escalation is judged automatically, risky ones are rejected.
      agent-review:
        sandbox: danger-full-access
        approval: ask
        name: 自动审查
        description: Full access base; every tool call is reviewed by the Jev judge before execution, risky calls are rejected with no human fallback.
      danger-full-access: { sandbox: danger-full-access, approval: never }
```

3. **不要**再在 profile 的 `cordis.patch.yml` 里手工插这些行，否则同一 id 重复挂载、permission 表重复覆盖。
4. 重启 DSH。**必须重启**，Host 加载、typert 注册、client bundle 注入都在启动时发生。
5. 卸载：`dsh plugin --profile web remove dsh-agent-approval`（自动从 bundles 列表移除）。
6. **可选（权限菜单图标）**：菜单图标在官方 bundle 的硬编码映射里，标准安装不会补——本地开发想要图标就 `npm run patch:glyph`（见第 8 节）。

### 10. DSH 0.1.7-rc.1 兼容（v1.7.0）

对照 npm tarball 逐文件 diff（0.1.5-rc.3 → 0.1.7-rc.1）核对过本插件触及的全部宿主 API 面，结论：

- **唯一硬破坏：Typert codec 契约**。0.1.7 的 `dsh-typert-loader` / `dsh-typert-registry`（Host+Client）都把「zod v4 `codec.schema`」换成了「`codec.create()` 工厂」（gateway 运行时 `codec.create().parse(value)`，`schemas[]` 条目同理）。v1.6.0 及更早在 0.1.7 上注册即被拒：Host 侧 manifest 注册失败、Remote 全挂；Client 侧 `$mount` 抛错、整个 client bundle 的 apply 失败。修法即第 1 节「codec 双格式」。
- **逐项核对过、无需改动的面**：
  - `approval/request` 瀑布、`ApprovalRequestEvent`（agent/toolName/callId/reason/signal）、`ApprovalOutcome` 四值、`approval.setPolicy`/`overrideOf`/`config.policy` 全部原样。
  - `subagents.start("spawn")` 请求形（label/prompt/parent/signal/agentOptions/outputSchema/toolFilter/persona）与 `SubagentRun`（id/result/dispose）原样；`assertObjectJsonSchema` 受限子集未变（`dsh-invariants` 无改动）。
  - `session.snapshotEvents()` 在 0.1.7 被标记**弃用**（"现有逻辑可以暂不迁移，但禁止新增生产调用"，`eventAt`/`ownEvents` 同批），仍可用——`_eventsOf` 的双形读取保留。
  - `session.header`/`session.id`/`session.append`、`session/event`/`session/disposed` 事件签名不变；`tool/call`、`user/message` 数据形不变（`source.kind === "user"` 过滤依旧正确——`approval.setPolicy` 的切换通知在 0.1.7 改成 `source.kind: "user-approval"`，恰好被我们的过滤排除）。
  - `permissionPresets` 的 Config 表 schema 未变（`name`/`description` 仍可选），`names` getter / `resolve()` 形状未变；但 0.1.7 新增**保留字 `auto` / `custom`**——预设 key 不可再用这两个（构造期直接 throw），`auto` 是实验性的 per-call review 预设（`registerAuto`），且出厂默认表只剩 workspace-write / danger-full-access。我们的 `cordis.patch.yml` 整表覆盖不受影响，key 避开保留字即可。
  - `commands.register` 新增**可选** `definitionId`（缺省合法）；`systemPrompt.context({name,order,text})` 未变（`context.agent` 来自 dsh-agent 对 AssembleContext 的模块增强，仍在）；`sessionTitle.get(session)`、`agentDefaultModel.currentSelection()`、`sessionPersistence.locate(header)`、`sandboxPolicy.defaultMode`、`llm.listProviders/listModels` 全部原样。
  - `agent/created` 从 `@mode emit` 改为 **`@mode serial`**：监听器按注册顺序被 await，抛错/返回 rejected Promise 会**使创建失败**。我们的监听器同步且全包 try/catch，合规；**以后改这个监听器绝不能抛错或返回 Promise**。`agent/session-start` 事件已删除（本插件未用）。
  - client 槽位：`settings.section`（id/order/label）与 `conversation.view` 契约未变（owner props 多了 `inspectCall`/`openView` 等，多余 prop 无害）；`SessionStandardProps.useSession` 仍在、`SessionSnapshot.sessionId` 叶子保留（0.1.7 另给 `props.sessionId`，可选用）；Remote 返回信封统一为 `RemoteResult`（`{ok,value}|{ok,error}`），被 client `pick()` 的多形解包覆盖。
  - client bundle 注册契约（`__ModuleLoader__.load({id,factory})`、`exports.inject=["slots","remote"]`、id = 包名）未变；`Remote`/`TypertRemoteService`/`markRemoteMethod` 驱动方式未变，`remoteMethods` 描述符形状未变（gateway 0.1.5 与 0.1.7 的消费代码逐行同形）。
- **0.1.7 的 UI 搬迁**（只影响 glyph 修补，见第 8 节）：`/permission` 菜单与 composer 触发按钮从 `dsh-client-ui-conversation`（`PermissionSelect` 已删除）搬到独立包 `dsh-client-ui-permission-presets`，composer 里挂新 slot `conversation.input.permission`；菜单仍是同一 Menu 原语（`button[role=menuitem]` + itemIcon span）。
- **依赖对齐**：0.1.7 宿主的 cordis 是 4.0.4、typert-protocol 是 0.1.7-rc.1。已验证插件 node_modules 里的旧副本（cordis 4.0.1 / typert-protocol 0.1.1-rc.2）在 0.1.7 下照常工作（`Service.init` 等符号是 `Symbol.for` 全局共享；`bindTypertRemote` 的 `ctx.invocation` accessor 是 0.1.7 新增的可选面，旧副本没有也无影响）；如遇漂移按第 9 节对齐即可。
- **DSH 版本声明走 peerDependencies，不走 dsh.plugin.json**：宿主版本声明的官方槽位是 `package.json#peerDependencies` 里名为 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 的条目——0.1.7+ 的 app-boot 启动预检（`plugin-compatibility.js` 的 `evaluatePluginCompatibility`；**0.1.5 及更早没有这段，范围只在 0.1.7+ 运行时被评估**）对每个这样的 peer 跑 `semver.satisfies(runtime, range, { includePrerelease: true })`，不匹配就告警并可用 `dsh plugin allow-version` 做精确版本豁免（`peerDependenciesMeta.optional` **不免检**）。本插件声明 `"@deepseek-ai/dsh": "^0.1.5-rc.3"`（= 实测支持线 0.1.5-rc.3 ~ 0.1.7-rc.1，`<0.2.0` 上限强制 0.2.0 前重验），并配 `peerDependenciesMeta.@deepseek-ai/dsh.optional = true`——**optional 是给安装器看的**（免得 npm/pnpm 把整套 `@deepseek-ai/dsh` CLI 运行时当缺失 peer 自动装进来），**预检照读不误**。**dsh-market（dshmarket.com）从 npm manifest 读三种宿主声明并合取判定**（`discovery-compatibility.ts` #577：顶层 `engines.dsh`、`dsh.engines.dsh`、以及 `@deepseek-ai/dsh*` peers；判定同样 `includePrerelease`），所以本插件另在 `package.json#dsh.engines.dsh` 写了同一范围 `^0.1.5-rc.3`——引擎形状给市场徽标/`compatibleWithHost` 过滤用，peer 形状给 0.1.7 启动闸门用，**两处范围必须同步改**（市场侧装机预检对 optional peer 不报风险，但 discovery 不读 optional 标记，peer 声明照样计入）。市场对 0.2+ 宿主的展示与闸门可能短暂不一致（peer 的隐式上限在市场侧被软化为警告），以启动闸门为准。注意 `dsh.plugin.json`（社区 plugin-registry 渠道的清单，`dsh registry install` 用）的 `engines.dsh` **不是 DSH 契约**——没有任何 DSH 版本读它；本插件走 npm + `dsh plugin add` 官方渠道，不需要该文件。版本声明要发新 npm 版本（v1.7.1+）后市场才读得到；市场页 README/版本是每日 CI 的快照，会滞后。
- **验证工具**：`scripts/check-typert-manifest.mjs`（已挂进 `npm run check`）——镜像两代 loader/registry 的 codec 校验器跑 manifest、从真实 client.js 提取 CLIENT_REMOTE 做 id/参数/typeSymbol 对齐检查；设 `DSH_TYPERT_REGISTRY`（可加 `DSH_TYPERT_REGISTRY_2`）指向真实安装的 `@deepseek-ai/dsh-typert-registry/lib/index.js` 时，还会用**真注册表**跑一遍注册。本次修复已用 0.1.5-rc.3 与 0.1.7-rc.1 两代真注册表验证通过（Host manifest + Client descriptors 双双接受）。

### 11. v1.8.0：LLM 直连裁决（默认）+ 自动审查模式（agent-review）

**显示名改名（用户拍板）**：用户可见文案「Agent 审批」→「**自动审批**」、「Agent 审查」→「**自动审查**」。代码标识一律不动：包名、`exports`、`/agent-approval`/`/agent-review` 命令、preset key `agent-approval`/`agent-review`、wire 描述符 id。**约定：设置页 label（`SETTINGS_LABEL`）与权限预设 `name` 必须保持同名**——`registerSettingsNavIcon`/`registerPermissionGlyphIcon`/`registerReviewMenuItem` 全是按显示文本匹配的 MutationObserver，改名时 `client.js` 的 `SETTINGS_LABEL`/`REVIEW_LABEL` 与 `cordis.patch.yml` 的 `name:` 必须同步，否则图标/gate 静默失配（历史上靠两 label 碰巧同名才工作）。

**改名后菜单仍是旧名 + 图标消失？查 profile 残留覆盖（2026-09-26 实踩）**：patch 应用顺序是 **bundle patch → `~/.dsh/profiles/web/cordis.patch.yml` → `--patch` overlays**，后者对 `permission` 行是**整行替换**。若 profile patch 里有历史手工粘贴的预设表（AGENTS.md 第 9 节本就警告过"不要手工插行"），它会在本包 bundle patch **之后**覆盖 `name`——宿主持续显示旧名，而 client 图标按新文本匹配不上 → 图标消失。修法：把 profile patch 里的 `permission` 行同步成新表（**注意保留其中的 `defaultPreset` 等用户配置**，不能整块删除——`presets` 整行替换语义下删行会丢表）。诊断口诀：宿主名字没变而 client 新了 = 查 `grep "Agent 审批" ~/.dsh/profiles/web/*.yml`。

#### 11a. LLM 直连裁决（`judgeMode: "llm"`，v1.8.0 起默认）

- **动机**：spawn 子代理有轻微上下文污染（会话列表多一条审批员子会话、请求会话日志写 `subagent/descriptor`）。默认裁决器改为**一次 `ctx.llm.stream()` 直连调用**（`_judgeWithLlmStream`），零子会话（审计 `childSessionId` 恒空）。`judgeMode: "subagent"` 保留旧行为（设置页「裁决方式」下拉，`setJudgeMode` 持久化到 config.json）。
- **输入/输出与 subagent 路径完全同构，仅调用方式不同**：同一 `APPROVER_PERSONA`（→ `system`）+ 同一 `_judgePrompt(...)`（→ user 消息）+ 同一 `VERDICT_SCHEMA` 契约（`_verdictFromJsonText` 做等价校验：三字段、enum、`additionalProperties:false`）。唯一文本差异是**输出指令尾巴参数化**（`OUTPUT_VIA_STRUCTURED_TOOL`/`PROMPT_TAIL_STRUCTURED` 对 spawn；`OUTPUT_VIA_JSON`/`PROMPT_TAIL_JSON` 对 stream）——persona 与 judgePrompt 其余部分逐字共享，**改审批口径两路自动同步**。
- **流聚合**（`_readLlmVerdict`，自建零依赖）：dsh-llm `StreamChunk` 协议（`block-start`/`text-delta`/`reasoning-delta`/`tool-call-delta`/`block-end`/`usage`/`finish`）。`block-end` 是权威组装块、**替换**已累计的同 index 增量（防双计）；要求「零或多个 reasoning 块 + 恰一个 text 块 + terminal finish `reason.kind === "stop"`」；`aborted` finish 抛 AbortError（映射 `cancelled`），其他一切异常形态 → `unavailable`（fail-closed）。text 剥 code fence / 提取 `{...}` 再解析。
- **路由**：复用 `_judgeRoute()`；解析到 `inherit(requester)` 时用 `session.requestHeader().config` 的会话自身路由（官方 auto-review 同源读法）；仍无 → `unavailable`。**`llm` 服务缺席不写兜底**（用户裁定：它缺席连主 agent 都跑不起来）——直接 fail-closed 记录。审计 model 列 `llm(<provider>/<model>)`。
- `_jevVerdict` 的解析已抽成 **`_jevParse`**（malformed / low-confidence / verdict 三态），与审查模式的 `_reviewWithJev` 共用同一校验与置信度门控——**改 Jev 校验逻辑只改这一处**。

#### 11b. 自动审查模式（`agent-review` 预设，逐调用审查，实验）

- **形态**（对齐官方 `@deepseek-ai/dsh-experimental-auto-review` 的 `auto` 预设，但裁决器为 Jev 且 **deny 不转人工**）：`tools/pre-execute` 瀑布 prepend（`_onPreExecute`）+ `danger-full-access` 基线 + `ask` 档位。**覆盖 native + 每个 PTC inner 调用**（`exec.parent`），**排除外层 `run_code` transport**（`RUN_CODE_TOOL`，对齐官方）。key `agent-review` 避开保留字 `auto`/`custom`。
- **裁决链**：规则表 → 会话内信任缓存 → Jev（`_reviewWithJev`；`JEV_REVIEW_QUESTIONS` = `JEV_QUESTIONS` 只换 decision 措辞）。state 比 `_jevStateOf` 多 `toolDescription`/`toolParameters`（官方 reviewer 也拿 schema；`exec.schema` 或 request header tools 查找，best-effort）。
- **deny 一律 fail-closed（用户拍板，与官方 auto 的 ask 兜底刻意不同）**：reject、低置信、超时、网络故障、畸形返回全部 → `{kind:"deny", info:{name:"AgentReviewDeniedError", code:"AGENT_REVIEW_DENIED", reason:<Jev 风险理由>}}`，body 不执行、**不转人工**；取消 → `{kind:"cancel"}`。低置信审计记 `unavailable`（对称门控照旧）。误杀治理靠短路降噪，「拒绝后转人工」开关列 future。**`ask` 档位只是预设必填旋钮值，不代表拒绝会问人。**
- **开启门槛（Jev gate，三层）**：判据 `_jevGateOk()` = Provider 为 `typesafe` **且** key 可解析（config 或 env）。① client 按 `getState().reviewAvailable` 设 `body[data-dsh-agent-approval-review-gate]`，gate 关时 CSS 隐藏「自动审查」菜单行（`registerReviewMenuItem` + `REVIEW_ITEM_MARKER`）；② 命令/`_setReviewEnabled` 开启前校验；③ **联动兜底**（`_reviewGateFallback`）：preset 事件或重启恢复折出 `agent-review` 而 gate 关 → 记审计（model 列 `gate`）+ `permissionPresets.set(session, PRESET_NAME)` 弹回自动审批预设，**绝不让会话裸奔 Full access**。
- **审计**：entry 新增 `mode: "escalation" | "review"`（`_recordShape` 统一补齐，旧旁路行缺省折 `escalation`；typert strict schema 三处同步；client 工具列显示「逐调用」徽标）。
- **命令/生命周期**：`/agent-review on|off`（`_setReviewEnabled` → `_enableCore(session, agent, "review")`，钉 `danger-full-access` + `ask`）；关闭/切走走 `_disable`（恢复 prev 旋钮，返回文案按 entry.mode 区分）；`agent/created` 折出 `agent-review` 重启恢复（**再过一遍 gate**，key 被删则弹回）；`_enabled` 条目带 `mode`，`_onPreExecute` 只认 `mode === "review"` 的会话，`_onApprovalRequest` 只认 escalation 会话（两模式互不串台）。
- **全局默认开关（v1.8.0，`setReviewDefault`，设置页「逐调用审查」下拉）**：开启后**新会话**（`_isFreshSession`：日志里还没有真实用户消息）自动进入自动审查（再过 gate；不过则按普通默认走）。**恢复的会话绝不翻转**——它们折叠出的 preset 是用户过去的选择。现存会话的切换仍走菜单/命令。持久化在 config.json `reviewDefault`。
- **设置页条件布局**：Provider = TypeSafe Jev → 显示「自动审查」卡片（含逐调用审查开关），隐藏「裁决方式」（Jev 是 HTTP 直连，LLM 直连/子代理之分无意义）；Provider ≠ Jev → 显示「裁决方式」（LLM 直连/隔离子代理），隐藏「自动审查」卡片。
- **勿与官方 experimental-auto-review 同开会话**：`tools/pre-execute` 会叠两层互不知情的裁决。

## 开发 / 验证

```bash
npm run check            # node --check 全部脚本 + scripts/check-typert-manifest.mjs 双代 Typert 契约冒烟
dsh plugin --profile web add /path/to/dsh-agent-approval   # 安装/重装到本机 DSH profile
npm run patch:glyph      # 可选：权限菜单图标（幂等）
```

改插件后**必须重启 DSH 进程**才生效。验证：
1. 输入框 `/permission` 菜单出现第四项 **自动审批**；设置 → 侧栏导航出现 **自动审批** 页（模型/超时可保存）。
2. 用 `/agent-approval on` 或菜单选 **自动审批** 为会话开启（两条路径等价）；输入框左侧**不再有**「🛡 审批」chip。
3. 开启后让工作区内命令触发一次提权重试（`sandbox_permissions`）：**不弹人工审批**，片刻后工具结果即为批准/拒绝；会话窗口顶部出现**「审批」标签页**（轨迹旁），点开能看到这条记录（含风险等级与理由；10s 内自动刷新，也可手动点「刷新」）。
4. `/agent-approval off` 关闭：沙箱模式与审批策略恢复开启前的值，菜单同步切回对应预设；再次提权回到人工弹窗（ask）或原策略行为。
5. 菜单切到 danger-full-access：模式自动关闭（`permission/preset` 事件联动，立即生效）；菜单切回 自动审批：模式自动开启，无需手动执行命令。
6. 把审批超时调成 30000ms、审批模型指向一个不存在的路由 → 提权应 fail-closed 拒绝并记录 `unavailable`。
7. 设置页加一条 allow 规则（如工具 `pwsh` + match 子串）→ 命中的提权**不再起审批子代理**，审计 model 列显示 `rule`；模型批准的提权在同一会话内以完全相同参数再次发起 → 直接放行，model 列显示 `trust`；「审批」tab 审计行点「加白」→ 规则表新增对应 allow 规则。
8. 审批模型 Provider 切到 **TypeSafe Jev**（第 4b 节）：未配 Key 时提权应立即 fail-closed 拒绝并记录 `unavailable`（理由注明缺 Key）；配好 Key（或设 `TYPESAFE_API_KEY`）后模型判定应亚秒级完成、审计 model 列显示实际版本（如 `jev(jev-1.13.0)`）、理由列为概率合成文本；把置信度阈值调到 0.99 → 大概率低置信 `unavailable`（既不批准也不记拒绝）；Endpoint 指向不存在的主机 → 网络错误 `unavailable`；规则表命中的提权在 Jev 模式下**依旧短路**（不发 HTTP 请求）。
9. （DSH 0.1.7-rc.1 宿主，见第 10 节）重启后 `/permission` 菜单与设置页正常打开即证明 codec 双格式注册成功（旧版 ≤1.6.0 在 0.1.7 上这两处直接死）；权限菜单行的盾牌图标若缺失只影响观感（glyph-set 守卫跨代 CSS 类名），功能不受影响。
10. （v1.8.0 功能 A，见第 11a 节）**默认即 LLM 直连**：开启自动审批后触发一次提权 → 亚秒级裁决、审计 model 列 `llm(<provider>/<model>)`、`childSessionId` 空，且**会话列表不出现审批员子会话**（零上下文污染核验）；「裁决方式」切「隔离子代理」→ 恢复旧行为（子会话出现、childSessionId 有值）；模型路由指向不存在的模型 → `unavailable`；超时调 30s + 大上下文 → `unavailable`；规则/信任短路照常（不发 LLM 请求）。
11. （v1.8.0 功能 B，见第 11b 节）设置页启用 Jev 后，`/permission` 菜单出现 **自动审查**；未配 Jev 时该菜单行不可见、`/agent-review on` 报错；选中后触发一次普通工具调用 → 不打断、执行前经 Jev 一次（「审批」tab 出现 mode=逐调用 记录）；高危调用（如删工作区外文件）→ **直接拒绝、body 不执行**（工具结果带 `AGENT_REVIEW_DENIED` detail），**不弹人工**；低置信/超时/路由故障 → 同样直接拒绝并记 `unavailable`；同参数再调 → trust 短路；关掉 Jev 配置后重启 → 会话回退 自动审批 预设（不裸奔 Full access）；切回 workspace-write 预设 → 旋钮恢复、不再逐调用审查。
12. （v1.8.0 改名）`/permission` 菜单显示 **自动审批**（不再是 Agent 审批），输入框权限触发按钮同步显示 **自动审批**，设置页侧栏出现 **自动审批** 页；菜单行盾牌图标与设置页 shield 图标照常显示（文本匹配 observer 已同步，无静默失配）；`/agent-approval on|off` 命令仍可用（命令名不动）。

## 发布

打 `v1.0.0` 标签推送 GitHub，`.github/workflows/release.yml` 自动 `npm pack` 并发布 GitHub Release（需要 `GH_TOKEN` secret，权限 `contents:write`）。

## 常规注意事项

- **不要直接编辑 `~/.dsh/profiles/web/cordis.yml`**（生成文件，patch 写在 `cordis.patch.yml`）。
- 监听器**绝不能抛异常**：瀑布层的兜底会把异常归一为 `unavailable`，但要自己 catch 并记录，否则审计里看不到原因。
- 声称（claim）的范围是"该会话的**所有** approval 请求"——不止 pwsh/bash 提权，也包括任何 `tools/pre-execute` 产生的人工 ask。这是有意语义（"帮我审批"），提示词写成通用审批口径。
- `approval.setPolicy` 会在模型上下文里注入 "changed by the user" 通知——用户确实主动开了开关，语义可接受；不要绕开它手写 `approval/policy` 事件（会丢失通知）。
- 审批模型未配置时使用 **Harness 默认路由**（`agentDefaultModel.currentSelection()`；该可选服务缺席或解析为空时才退化为继承请求会话路由）；配置后走 `agentOptions` 精确覆盖。**刻意不跟随请求会话的模型**——审批口径必须稳定可预期，不随各会话的模型切换而漂移。
- 审计记录（v1.5.1 起）存在**会话存储目录内的旁路文件** `<sessionDir>/agent-approval.jsonl`（经 `sessionPersistence.locate` 定位；v1.4→v1.5 迁移用 `scripts/migrate-records.mjs`，见第 6 节）；插件只持久化**设置**——审批模型、Jev 配置（apiKey/endpoint/model/confidence）与超时都在 `<DSH_HOME>/agent-approval/config.json`（重启恢复，不再回落默认；Key 明文保存，与模型/超时同一信任域）。持久化失败是 best-effort 静默降级，绝不影响审批主流程。DSH 的权威审计仍在会话日志的 `approval/asked` + `approval/decided` 事件对（本插件不破坏该配对，只在瀑布层给结论）。
