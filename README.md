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
| ⛔ 风险即拒绝 | 破坏性 / 不可逆 / 越界（含修改操作系统或其他应用数据）/ 理由与实际命令不符 → 直接 `reject`；仅"安全、可逆、与任务相符、理由诚实"才 `approve`——项目自身的安装/部署脚本写其文档指定路径属任务所需 |
| 🔒 Fail-closed | 审批 Agent 启动失败、超时（可配 30s–600s）、结果不合法 → 一律按拒绝处理，绝不静默放行 |
| ⚙️ 审批模型可配置 | 设置页选择 Provider + Model，不选则固定用 **Harness 默认模型**（不跟随请求会话，口径稳定）；选择与超时**持久保存**，重启不丢 |
| 📋 审计记录 | 设置页查看最近审批：结论 / 风险等级 / 模型 / 耗时 / 理由；悬停看完整理由与**精确工具参数**；审批 Agent 的会话 id 可回溯完整推理；记录**本地持久化**（重启保留最近 200 条） |
| 🔁 可逆开关 | 权限菜单「Agent 审批」预设、`/agent-approval on\|off` 命令两条等价路径；关闭时**恢复开启前的权限旋钮** |

## 工作原理

```
开启（菜单 / 命令）
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

- 审批 Agent 只能看到：workspace 路径、**最近的用户消息**（任务上下文）、工具名、提权理由、**精确的工具参数 JSON**（按 `callId` 从会话日志回查）。裁决看"操作 vs 用户任务"的客观对齐，不依赖理由措辞。
- 子代理审批策略被 DSH 委派机制钉死为 `never`，不存在递归审批；全局工具全部空白，审批员只能"判"不能"做"。
- 未开启的会话完全不受影响（监听器原样 `next()`，人工审批行为不变）。

## 安装

### 标准安装（推荐）

本插件是**标准 DSH bundle**：`package.json` 声明 `dsh.bundle.patch`，包内 `cordis.patch.yml` 同时完成两件事——`- insert:` 挂载插件本身，`- id: permission` 把 **Agent 审批** 预设注册进 `/permission` 菜单。用官方 `dsh plugin` 命令安装：

```bash
# 本地开发：pnpm 软链到本仓库，改代码即生效（无需重新复制）
dsh plugin --profile web add /path/to/dsh-agent-approval

# 正式发布：从 GitHub Release tarball 安装
dsh plugin --profile web add https://github.com/MoonlitDropOfBlood/dsh-agent-approval/releases/download/v1.2.0/dsh-agent-approval-1.2.0.tgz
```

重启 DSH 后：设置面板出现 **Agent 审批** 页；`/permission` 菜单出现第四项 **Agent 审批**。

> **可选：权限菜单图标**。菜单图标硬编码在官方 `dsh-client-ui-conversation` 的 `permissionGlyphs` 映射里（无公开注册口），标准安装不会补它——不跑下面的命令只是**菜单项没有图标**，预设与功能不受影响。想让菜单项带盾牌图标，装完再跑一次（幂等；DSH 升级重装原版 bundle 后重跑即可）：
> ```bash
> npm run patch:glyph
> ```

> `dsh plugin add` 把插件装成 profile 的 npm 依赖并追加到 `dsh.profile.bundles`，启动时自动应用包内 patch。卸载：`dsh plugin --profile web remove dsh-agent-approval`。

## 使用

1. **开启**：在 `/permission` 菜单选 **Agent 审批**，或输入 `/agent-approval on`。
2. **自动裁决**：之后该会话里的提权请求（例如命令被沙箱拒绝后带 `sandbox_permissions` 的重试）不再弹窗，由审批 Agent 在后台裁决并放行/拒绝。
3. **审计**：设置 → **Agent 审批** → 审批记录；悬停"审批理由"看完整理由与工具参数。
4. **配置**：同页设置审批模型（不选则用 Harness 默认模型）与审批超时。
5. **关闭**：菜单切回其他预设，或 `/agent-approval off`，恢复开启前的沙箱模式与审批策略。

## 目录结构

```
dsh-agent-approval/
├── index.js            # Host 半：AgentApprovalService（审批瀑布抢占 + spawn 审批 Agent + 审计）
├── client.js           # Client 半：设置页「Agent 审批」+ 输入框开关 UI bundle
├── typert.host.js      # Typert Host manifest（agentApproval 6 个方法的描述）
├── cordis.patch.yml      # dsh bundle patch（挂载行 + permission 预设表覆盖）
├── scripts/patch-glyph.mjs # 可选：权限菜单图标补丁（标准安装不自动执行）
├── .github/workflows/  # GitHub Actions 发布
├── AGENTS.md           # 面向 AI agent 的开发指南（含踩坑）
└── LICENSE             # MIT
```

## 开发

```bash
npm run check           # node --check index.js client.js typert.host.js
dsh plugin --profile web add /path/to/dsh-agent-approval   # 安装/重装到本机 DSH profile
npm run patch:glyph     # 可选：权限菜单图标
```

详见 [AGENTS.md](AGENTS.md)——记录了 DSH 正式插件（Host/Client/Typert 三件套）的完整机制、审批瀑布 prepend 抢占与结构化子代理裁决的踩坑。

## License

本项目遵循 [MIT License](LICENSE)。

> 本项目是基于 DeepSeek Harness 构建的社区插件，并非 DeepSeek 官方产品。
