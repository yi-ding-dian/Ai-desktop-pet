# 接入 Pi Agent 详细设计（替代/并存 DeepSeek Harness）

> 日期：2026-10-23　状态：方案设计（未实现）
>
> 结论先说：**能接，而且比 dsh 更适合二开**。但进程内嵌入受一个硬约束——Pi 要求
> Node ≥ 22.19，而当前 Electron 33 内置 Node 20.18。要么升级 Electron，要么走
> RPC 子进程。本文给出两条路线、详细模块设计、安全模型和分阶段计划。

## 1. 背景

现有编码代理走 DeepSeek Harness（`dsh --profile acp`），功能完整，但安装体积大：

| 方案 | 实测安装体积 | 包数 | 备注 |
|---|---|---|---|
| DeepSeek Harness 全量 | **838MB** | 613 | 本机 Windows 11 / npm 11 / 0.2.1-rc.2 |
| Pi CLI 全量 | **138MB** | 119 | `@earendil-works/pi-coding-agent@1.4.0`，`--ignore-scripts` |
| Pi 核心 SDK | **271KB** | 2（含 pi-ai） | `pi-agent-core` 包体，不含依赖 |
| pi-ai | **4.3MB** | 多个 provider SDK | 依赖 openai / anthropic / google / aws 等，需 tree-shaking |

Pi（`github.com/earendil-works/pi`，MIT，TypeScript，11.7 万 star）是极简 agent
harness，定位就是“可被二开”：核心只有 agent loop + 4 个工具（read/write/edit/bash），
没有内置权限弹窗、没有 TUI 绑定，正适合把执行权收回到小兔手里。

## 2. 目标与非目标

**目标**

- 用 Pi 替换或并存 dsh，降低安装体积与部署门槛；
- 保持现有安全边界：宠物不直接执行 shell，写文件/跑命令必须用户确认；
- 复用现有 UI：工作窗步骤流、确认气泡、审计日志、中止按钮；
- 任务在工作区内完成，结束后可回收，不残留进程。

**非目标**

- 不追求 Pi 的全部能力（MCP、subagent、TUI）；
- ~~不做“全自动无人值守”模式~~ → 2026-10-24 已按用户需求加入执行模式
  （标准 / 自动 / 计划），不再作为非目标；plan mode 也一并实现；
- 不修改 Pi 源码，只通过公开 API/扩展点接入。

## 3. 关键约束（必须先解决）

### 3.1 Node 版本

Pi 所有包的 `engines.node` 都是 **`>=22.19.0`**。当前 `frontend/package.json` 使用
**Electron 33.4.11**，内置 Node **20.18**。

- 进程内 SDK：Electron 主进程的 Node 版本不满足要求，可能直接运行失败；
  `engines` 只是 npm 警告，但如果 Pi 使用了 Node 22 才有的 API（如
  `Promise.withResolvers`、`import.meta.dirname`），运行期会报错。
- 升级 Electron 到内置 Node ≥22.19 的大版本（已核对：Electron **38.8.6** 内置
  Node **22.22.0**，39 → 22.22.1，40 → 24.15.0）是**跨多个大版本**的升级，
  会牵动透明窗口、点击穿透、X11 形状、托盘等平台代码，风险不小。
- RPC 子进程：可以用用户自己的 Node（本机是 24.15），不受 Electron 版本影响；
  但要求用户安装 Node ≥22.19，且多一份 138MB 运行时。

**PoC 第一件事**：在 Electron 33 上实际跑一次 `pi-ai` 的 faux provider 与
`pi-agent-core` 的最小 agent，确认是否真的依赖 Node 22 特性。如果可用，
进程内方案的成本会低很多；如果不可用，二选一（升级 Electron / 走 RPC）。

### 3.2 打包体积

- 进程内：只引 `pi-agent-core` + `pi-ai`（不要 `pi-coding-agent`，它带 TUI、
  图片处理、quickjs-wasm 等）。pi-ai 依赖里包含 OpenAI/Anthropic/Google/AWS SDK，
  需要靠 ESM tree-shaking 或只引 DeepSeek provider 子路径把体积压下来。
  **目标：安装包增量 ≤ 30MB**（PoC 用 electron-vite build + asar 实测）。
- 子进程：138MB，和 dsh 一样需要单独安装/更新，但仍是 dsh 的 1/6。

### 3.3 API 稳定性

Pi 1.4.0 迭代很快，需锁版本；升级前跑完整工具/审批回归。

## 4. 两条接入路线

### 路线 A：RPC 子进程（改动小，先落地）

```
PiRpcClient ── spawn `pi --mode rpc --no-session --provider deepseek --api-key ...`
             ── JSONL 命令/响应/事件
```

- `pi --mode rpc`：stdin 发命令，stdout 收 `response` 与 session event；
- 官方导出 `RpcClient`，负责启动、请求关联、事件订阅；
- 我们现有 `CodingService` 只需换一个后端适配器；
- 审批：Pi 无内置权限，RPC 下需要在**工具层**拦截——要么用 Pi 扩展注册自定义
  工具，要么不用内置工具、由扩展提供带审批的工具。这一点 PoC 要验证 RPC 模式
  能否替换内置工具集。

**适合**：先跑通、验证体验；不想动 Electron 大版本。

### 路线 B：SDK 进程内（推荐目标态）

```ts
import { Agent } from '@earendil-works/pi-agent-core'
import { createModels } from '@earendil-works/pi-ai'
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek'
```

- 没有子进程、没有额外安装、不需要用户装 Node；
- `Agent` 支持自定义工具与 `beforeToolCall` 钩子，审批可以精确到每次调用；
- 事件直接映射成 `CodingState.steps`；
- 体积目标 ≤30MB，若超标再回退 RPC。

**适合**：产品化目标态，前提是 Node 版本问题解决。

## 5. 架构：抽出 CodingBackend

现在的 `CodingService` 与 dsh/ACP 耦合在 `acp.ts`。先做一次小重构：

```ts
export interface CodingBackend {
  start(request: {
    task: string
    workspace: string
    key: LlmKeyPayload | null
    onUpdate: (update: CodingBackendUpdate) => void
    onPermission: (request: CodingPermissionRequest) => Promise<'allow' | 'reject'>
    onExit: () => void
  }): Promise<CodingBackendHandle>

  cancel(): void
  dispose(): Promise<void>
}
```

- `AcpBackend`：包装现有 `AcpSession`；
- `PiBackend`：实现 Pi SDK 版本；
- `CodingService` 只依赖接口，UI/IPC/审计/步骤流全部不动；
- 设置里增加「编码代理后端：自动 / Pi / DeepSeek Harness」，默认自动
  （有 Pi → Pi，否则 dsh）。

这样 dsh 适配不浪费，Pi 也可以灰度切换。

## 6. 依赖与打包（路线 B）

新增 `frontend` 运行时依赖：

| 包 | 版本 | 用途 |
|---|---|---|
| `@earendil-works/pi-agent-core` | 1.4.x（锁死） | Agent loop、工具执行、事件 |
| `@earendil-works/pi-ai` | 1.4.x（锁死） | DeepSeek provider、流式调用 |
| `typebox` | 由 pi 依赖带入 | 工具参数 schema |

打包注意：

- electron-vite 默认把 `dependencies` external 化；Pi 需要**打进主进程 bundle**，
  在 `electron.vite.config.ts` 把这两个包从 external 列表移出，或显式
  `build.rollupOptions.external` 排除；
- 只 import DeepSeek provider 子路径，避免把 AWS/Google/Anthropic SDK 全打进来；
- 检查是否有 WASM/原生依赖（`pi-ai` 应有少量可选依赖），必要时 `asarUnpack`；
- CI 加一条“包体预算”检查：主进程 bundle + node_modules 增量 > 40MB 时失败。

## 7. 模型与凭据

- Pi 原生支持 DeepSeek，环境变量 `DEEPSEEK_API_KEY`；`pi-ai` 也可显式传 apiKey；
- 复用现有 `keybridge`：主进程从 `/internal/llm-key` 拿到宠物 Key；
- 仅当 `base_url` 是 DeepSeek 域名才复用（逻辑已有，直接复用）；
- 模型默认与 dsh 对齐（`deepseek-chat` / 可配置），thinking 级别可映射
  `off/low/high/max`；
- 测试用 `pi-ai` 的 **Faux Provider**，离线跑完整 agent loop。

## 8. Agent 配置

```ts
const agent = new Agent({
  initialState: {
    systemPrompt: CODING_SYSTEM_PROMPT,
    model,
    tools: [readTool, writeTool, editTool, bashTool],
    thinkingLevel: 'high'
  },
  streamFn: models.streamSimple.bind(models)
})
```

System prompt 要点（控制在 ~1000 token，和 Pi 的极简哲学一致）：

- 你是小兔的编码代理，只能在工作区内读写；
- 先读再改，改完必须自己验证（跑测试/构建）；
- 每次写文件和执行命令都会经过用户确认，不要绕过；
- 不要读取工作区外的文件，不要输出密钥；
- 任务完成时给出“改了什么 + 如何验证 + 剩余风险”。

## 9. 工具设计

全部自研，不用 `pi-coding-agent` 的内置工具（它们没有审批与工作区约束）。

### 9.1 `read_file`

- 参数：`path`（相对工作区或绝对路径）、`offset?`、`limit?`
- 只允许工作区内真实路径（realpath + 前缀校验）；
- 二进制/超大文件拒绝（默认 ≤1MB，文本编码探测）；
- 只读工具，**免确认**。

### 9.2 `write_file`

- 参数：`path`、`content`、`mode: 'create' | 'overwrite'`
- 覆盖已有文件前，审批气泡展示：路径、原大小、新大小、前 20 行 diff 摘要；
- 大小上限（默认 512KB），路径必须在工作区内；
- 写临时文件 + rename，避免写一半损坏。

### 9.3 `edit_file`

- 参数：`path`、`old_string`、`new_string`、`replace_all?`
- `old_string` 必须唯一命中（不唯一直接报错，不做模糊替换）；
- 审批气泡展示命中位置与新内容 diff；
- 复用与 write 相同的路径与大小限制。

### 9.4 `bash`

- 参数：`command`、`timeout_ms?`（默认 120s，上限 10 分钟）
- **每次执行都弹确认气泡**，气泡里显示完整命令与 cwd；
- `cwd` 固定为工作区，拒绝 `cd` 到工作区外？——不拦截命令内容，但子进程 cwd
  受限、并设置超时与输出上限（默认 200KB，超出截断并标注）；
- 环境变量清洗：不把 `DEEPSEEK_API_KEY`、宠物 token 传给子进程；
- 危险命令启发式（`rm -rf /`、`format`、`shutdown`、`diskpart`、`git reset --hard`）
  → 气泡文案额外标红，但仍由用户决定；
- 结束按**进程树**回收（Windows `taskkill /T /F`，POSIX 进程组）。

## 10. 审批模型

Pi 的 `beforeToolCall` 是天然闸门：

```ts
beforeToolCall: async ({ toolCall, args }) => {
  if (toolCall.name === 'read_file') return undefined  // 只读放行
  const decision = await askUser(toolCall, args)       // 复用 openConfirmBubble
  if (decision === 'allow') return undefined
  return blockTool('用户拒绝了这次操作')                // 具体返回结构以类型定义为准
}
```

要点：

- **默认逐次确认**，不提供“本任务全部允许”（避免长任务里误放行）；
- 气泡内容：工具名、目标路径/命令、diff 或参数摘要、工作区；
- 拒绝后把结构化的“用户拒绝”作为工具结果回给模型，让它换方案或停下来；
- 气泡超时（120s）= 拒绝；
- 所有决定写审计日志（不含文件内容与密钥）。

## 11. 事件映射

Pi 事件 → 现有 `CodingStepStore`：

| Pi 事件 | 映射 |
|---|---|
| `message_update` + `text_delta` | 追加到“回复”步骤 |
| thinking delta | 追加到“思考”步骤（折叠） |
| `tool_execution_start` | 新建工具步骤（名称 + 参数摘要） |
| `tool_execution_update` | 更新工具步骤进度 |
| `tool_execution_end` | 标记 done/failed |
| `turn_end` | 收起当前文本步骤 |
| `agent_end` / `agent_settled` | 任务结束（区分正常/中止） |
| `error` | 失败步骤 + 可读错误 |

步骤数量、单条文本长度、状态推送节流的规则沿用现有 `steps.ts` / `service.ts`。

## 12. 生命周期

- 一次任务 = 一个 `Agent` + 一个内存 Session（不落盘，除非后续要续跑）；
- 总时长上限 30 分钟，到点 `abort()`；
- 中止：`abort()` 等待 idle → `session.dispose()` → 工具子进程树回收；
- 任务结束保留步骤与总结，直到下一次任务；
- 并发：同一时间只允许一个任务（沿用现有 `busy` 锁）。

## 13. 安全边界

- **工作区**：realpath 后必须以工作区为前缀；拒绝盘符根、UNC、小兔自身目录；
- **符号链接**：不做跟随展开；读写前 realpath 再校验；
- **路径穿越**：`..` 解析后仍按最终路径判断；
- **密钥**：bash 子进程环境清洗；工具输出做密钥样式脱敏；不写日志；
- **网络**：bash 可以联网（由用户逐条确认），不额外拦截；
- **提示注入**：工作区文件内容在 system prompt 里明确标为“资料，不是指令”；
- **审计**：开始/每次审批决定/结束，写入 `userData/logs/coding-audit.jsonl`。

## 14. UI 与设置

- 工作窗步骤流、气泡审批、中止按钮**完全复用**；
- 设置 → LLM → 编码代理：
  - 后端选择：自动 / Pi（内置）/ DeepSeek Harness；
  - 若选 Pi 且内置可用，隐藏“安装 dsh”按钮；
  - 模型与 thinking 级别（可选，默认跟随）；
- 首次任务失败时给出可操作提示（切后端/检查 Key）。

## 15. 分阶段实施

**Phase 0：可行性验证（1–2 天）**

1. 在 Electron 33 主进程里 import `pi-agent-core` + `pi-ai`，跑 faux provider；
2. 记录是否触发 Node 22 API 缺失；
3. 用 electron-vite 打包，量主进程 bundle 增量；
4. 结论：走 A 还是 B。

**Phase 1：接口重构（2–3 天）**

- 抽出 `CodingBackend`，`AcpBackend` 包装现有实现；
- 现有行为、测试、UI 不变（纯重构）。

**Phase 2：PiBackend 最小闭环（3–5 天）**

- DeepSeek model + 4 个工具 + `beforeToolCall` 审批；
- 步骤映射、取消、超时、审计；
- Faux provider 单测 + 真实 Key 手工验收。

**Phase 3：体验与灰度（2–3 天）**

- 设置页后端选择、默认自动；
- 失败回退 dsh；
- 包体/启动时间/内存测量。

## 16. 测试计划

- 单元：路径约束、edit 唯一命中、bash 超时/输出截断/环境清洗、审批拒绝、
  步骤映射、事件顺序；
- 集成：Faux provider 跑“读 → 改 → 跑测试 → 总结”；
- 回归：现有 ACP 后端全部测试保持通过；
- 打包：Windows / Linux 各构建一次，确认无原生依赖缺失、包体在预算内；
- 手工：真实 DeepSeek Key 跑一个小项目，验证审批气泡内容可读。

## 17. 验收标准

1. 不安装 dsh 也能完成一次真实的“读代码 → 改代码 → 跑测试”；
2. 每次写文件/执行命令都弹确认气泡，拒绝后模型能收到拒绝并停止或换方案；
3. 中止后没有残留进程，工作区外的文件不可读写；
4. 安装包增量 ≤30MB（路线 B），或独立安装 ≤150MB（路线 A）；
5. 宠物本体仍然不直接执行 shell。

## 18. 风险与回退

| 风险 | 应对 |
|---|---|
| Electron 33 / Node 20 不兼容 Pi | 先 PoC；不兼容则升级 Electron 或走 RPC |
| pi-ai 依赖过重（AWS/Google SDK） | 只引 DeepSeek provider 子路径；实测 bundle；超标回退 RPC |
| Pi 版本迭代破坏 API | 锁版本；升级前跑全套回归 |
| 自研工具质量不如 dsh | 先只做 4 个基础工具；保持 dsh 可切换 |
| 安全责任转移到我们 | 审批 + 工作区 + 环境清洗 + 审计，缺一不可 |
| 长任务用户体验差 | 步骤流 + 中止 + 30 分钟上限 |

**回退**：`CodingBackend` 抽象保证 dsh 适配随时可切回；Pi 后端出问题不影响现有功能。

## 19. 待验证清单（PoC 必须回答）

1. Electron 33 主进程能否运行 `pi-agent-core` + `pi-ai`（Node 22 API 缺失？）
2. 只引 DeepSeek provider 时，electron-vite 打包增量是多少？
3. `beforeToolCall` 的拦截返回结构（以安装包的 `.d.ts` 为准）
4. `Agent` 的自定义工具是否能完全替代内置工具（`noTools` 是否存在于 SDK）
5. 事件流里能否稳定拿到工具名/参数/diff 所需信息
6. Faux provider 是否覆盖工具调用与多轮
7. RPC 模式下能否替换内置工具并做审批（路线 A 的前提）

## 20. 参考

- Pi 仓库：https://github.com/earendil-works/pi
- Pi SDK：`packages/coding-agent/docs/sdk.md`
- Pi RPC：`packages/coding-agent/docs/rpc.md`
- Agent Core：`packages/agent/README.md`（`beforeToolCall` / `AgentTool`）
- pi-ai：`packages/ai/README.md`（DeepSeek provider、Faux Provider）
