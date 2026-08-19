<p align="center">
  <svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" color="#4D6BFE"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>
</p>

<h3 align="center">DeepSeek Harness Agent 审批权限插件</h3>

<p align="center">
  <img src="https://img.shields.io/badge/DSH-Plugin-4D6BFE?style=flat" alt="DSH plugin">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2EA44F?style=flat" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/Web%20UI-Yes-22C55E?style=flat" alt="Web UI">
</p>

<p align="center"><sub>中文</sub></p>

---

为 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) Web UI 打造的 **Agent 审批**权限插件：当内置的权限选项（`workspace-write + ask` / `danger-full-access + never`）不能满足需求时，为会话开启第三种模式——**以 workspace-write 为基线，提权请求交由独立审批 Agent 裁决，有风险就拒绝**。

## 功能

| 功能 | 说明 |
|---|---|
| 🛡 **权限菜单第四项** | `/permission` 菜单新增 **Agent 审批** 预设；选中即开启，切到其他预设自动关闭，跨重启保持 |
| 🤖 新权限模式 | 开启后：沙箱基线固定 `workspace-write`，审批策略切到 `ask`（内部接管），**不再弹人工审批** |
| 🤖 独立审批 Agent | 每次提权请求由一次性 `spawn` 子代理裁决：独立会话、零工具、只读材料，结构化输出 `{decision, riskLevel, rationale}` |
| ⛔ 风险即拒绝 | 破坏性 / 不可逆 / 越界 / 理由与实际命令不符 → 直接 `reject`；仅"安全、可逆、与任务相符、理由诚实"才 `approve` |
| 🔒 Fail-closed | 审批 Agent 启动失败、超时（可配 30s–600s）、结果不合法 → 一律按拒绝处理，绝不静默放行 |
| ⚙️ 审批模型可配置 | 设置页选择 Provider + Model，或**继承请求会话的路由** |
| 📋 审计记录 | 设置页查看最近审批：结论 / 风险等级 / 模型 / 耗时 / 理由；悬停看完整理由与**精确工具参数**；审批 Agent 的会话 id 可回溯完整推理 |
| 🔁 可逆开关 | 权限菜单、会话输入框「🛡 审批」chip、`/agent-approval on\|off` 三条等价路径；关闭时**恢复开启前的权限旋钮** |

## 工作原理

```
开启（chip / 命令）
  └─ 记住旧旋钮 → sandbox/mode=workspace-write + approval/policy=ask（规范写路径，可恢复）
        │
工具请求提权（sandbox_permissions / 人工 ask）
  └─ ctx.approval.request() → approval/request 瀑布
        └─ 本插件 prepend 抢占（先于人工弹窗 answerer）
              └─ spawn 审批 Agent（独立会话 · 零工具 · 结构化裁决 · 不会递归审批）
                    ├─ approve → allowed-once（该次放行）
                    ├─ reject  → rejected（风险操作，最终拒绝）
                    └─ 超时/故障/取消 → fail-closed（按拒绝处理）
              └─ 记入审计（设置页可见）
```

- 审批 Agent 只能看到：workspace 路径、工具名、提权理由、**精确的工具参数 JSON**（按 `callId` 从会话日志回查）。
- 子代理审批策略被 DSH 委派机制钉死为 `never`，不存在递归审批；全局工具全部空白，审批员只能"判"不能"做"。
- 未开启的会话完全不受影响（监听器原样 `next()`，人工审批行为不变）。

## 安装

### 本地安装

```bash
# 1. 克隆本仓库
git clone <your-github>/dsh-agent-approval.git
cd dsh-agent-approval

# 2. 安装到本机 DSH profile（复制插件包 + 写入 cordis.patch.yml）
node scripts/install.mjs

# 3. 重启 DSH（命令行：node <dsh bin> web --profile web）
```

重启后：设置面板出现 **Agent 审批** 页；会话输入框左侧出现「🛡 审批」开关。

> 需要插件能在 profile 的 `node_modules` 解析到依赖（`zod`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-typert-protocol`）。若本机 DSH 未提供这些依赖，先在插件目录 `npm install`，再手动把 `node_modules` 一并复制，或把插件作为依赖加入 profile。

### 手动安装（原理）

1. 将插件包放入 `<DSH_HOME>/profiles/web/node_modules/dsh-agent-approval/`。
2. 在 `<DSH_HOME>/profiles/web/cordis.patch.yml` 追加：

```yaml
- insert:
  - id: agent-approval
    name: 'dsh-agent-approval'
```

3. 重启 DSH。

## 使用

1. **开启**：任一会话输入框左侧点「🛡 审批」，或输入 `/agent-approval on`。
2. **自动裁决**：之后该会话里的提权请求（例如命令被沙箱拒绝后带 `sandbox_permissions` 的重试）不再弹窗，由审批 Agent 在后台裁决并放行/拒绝。
3. **审计**：设置 → **Agent 审批** → 审批记录；悬停"审批理由"看完整理由与工具参数。
4. **配置**：同页设置审批模型（不选则继承请求会话的模型）与审批超时。
5. **关闭**：再次点击 chip 或 `/agent-approval off`，恢复开启前的沙箱模式与审批策略。

## 目录结构

```
dsh-agent-approval/
├── index.js            # Host 半：AgentApprovalService（审批瀑布抢占 + spawn 审批 Agent + 审计）
├── client.js           # Client 半：设置页「Agent 审批」+ 输入框开关 UI bundle
├── typert.host.js      # Typert Host manifest（agentApproval 6 个方法的描述）
├── scripts/install.mjs # 本地安装脚本
├── .github/workflows/  # GitHub Actions 发布
├── AGENTS.md           # 面向 AI agent 的开发指南（含踩坑）
└── LICENSE             # MIT
```

## 开发

```bash
npm run check           # node --check index.js client.js typert.host.js
node scripts/install.mjs
```

详见 [AGENTS.md](AGENTS.md)——记录了 DSH 正式插件（Host/Client/Typert 三件套）的完整机制、审批瀑布 prepend 抢占与结构化子代理裁决的踩坑。

## License

本项目遵循 [MIT License](LICENSE)。

> 本项目是基于 DeepSeek Harness 构建的社区插件，并非 DeepSeek 官方产品。
