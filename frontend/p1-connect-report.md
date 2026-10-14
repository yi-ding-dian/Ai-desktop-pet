# 前后端打通报告（P1 步骤 4）

> 环境：Deepin Linux / X11；Node v22.23.1 / Electron 33.4.11；Python 3.12（backend/.venv）
> 日期：2026-10-14 17:2x；报告时**应用正在后台运行**（`npm run dev`，日志 `/tmp/pet-dev.log`）
> 结论：**完成**——后端 spawn → PET_READY → IPC 下发 → WS 连接 → hello_ack ok=true → 真实对话闭环（含流式 token / emotion / reply_end）→ 退出清理全部实测通过。

---

## ① 改动清单

```text
frontend/
├── electron/
│   ├── backend-process/                ← 新增：Python 子进程域（高内聚：进程管理只在此目录）
│   │   ├── index.ts                    spawn / READY 握手(15s 超时) / 崩溃重启(≤3次) / SIGTERM→3s→SIGKILL 清理 / IPC 广播
│   │   └── locate.ts                   后端定位（开发态源码 venv python / 生产态 PyInstaller 产物预留）
│   ├── ipc/
│   │   ├── channels.ts                 扩展：backend 通道常量 + BackendState/Status/Ready/Snapshot 类型 + PetBridgeApi.backend
│   │   └── index.ts                    注册 backend:get-snapshot（渲染晚订阅时的状态补发）
│   ├── main.ts                         接线：whenReady 后启动后端；before-quit 拦截 → 清理 → 真正退出
│   └── preload.ts                      暴露 backend.getSnapshot / onStatusChanged / onReady
├── src/
│   ├── shared/
│   │   ├── protocol/index.ts           新增：WS 协议 v1 TS 类型（逐字段对齐 protocol.py，含 TODO 注释：待改为 Pydantic 生成）
│   │   └── ws-client/
│   │       ├── index.ts                新增：WsClient（原生 WebSocket；重连 1s→30s 退避；心跳 30s ping/10s pong 判死；事件分发 type→订阅者）
│   │       └── bridge.ts               新增：pet-bridge 接线（backend-ready → connect；failed/stopped → disconnect；快照补状态）
│   ├── modules/chat/
│   │   ├── ChatPanel.tsx               新增：输入框(Enter 发送, IME 组合保护) + 气泡列表（token 逐字 / reply_end 定型 / emotion / error）
│   │   └── emotions.ts                 新增：情绪 emoji 占位映射（Live2D 未接的最简表现）
│   ├── App.tsx                         集成：顶部状态栏(状态/情绪) + 底部状态栏(后端/WS/调试) + 交互矩形加入聊天面板(ResizeObserver 跟随)
│   └── styles.css                      新增聊天面板/顶部状态栏样式；状态栏压缩为两行避免与输入框重叠
└── p1-connect-report.md                ← 本报告
```

未改后端任何代码；未动 `代码设计文档/`、`record.md`、版本控制。

**关键实现点**

- token：每次 spawn 生成 32 字节 hex，经 `PET_TOKEN` 传 Python；READY 行不含 token（生产模式），token 由主进程持有并经 `backend:ready` IPC 下发。
- 就绪超时 15s：超时 SIGKILL → 走统一"异常退出 → 重启"路径。连续失败 3 次置 `failed` 并 IPC 通知（简单版重启：1s/2s/4s 退避）。
- 渲染侧连接时机：先订阅 `backend-ready`，同时 `getSnapshot()` 兜底（防"ready 早于订阅"）；后端 failed/stopped 时主动断开 WS 等待下次 ready。
- 心跳无 pong 判死 → 强断 → 退避重连；重连成功重新 `hello`（新 token 场景已实测）。
- 聊天面板已纳入 X11 可交互形状（否则输入框会被穿透放行）。

---

## ② 启动 / 关闭

```bash
# 启动（开发态；等价于任务书命令，后端由主进程自动拉起，无需手动）
cd /home/yicaibao/my/Ai-desktop-pet/frontend
npm run dev > /tmp/pet-dev.log 2>&1 &     # 本次验证用后台方式
# 关闭
pkill -x electron                          # 或在终端 Ctrl+C
```

---

## ③ 集成验证结果（真实日志摘要）

### 3.1 冷启动链路（后端 READY → WS → hello_ack ok）

```text
[backend] 状态 -> starting（/home/yicaibao/my/Ai-desktop-pet/backend/.venv/bin/python -m backend.main（cwd=/home/yicaibao/my/Ai-desktop-pet））
[backend] 已拉起子进程 pid=399451：...
[backend] 2026-10-14 17:19:22 | INFO | __main__:111 - 后端就绪 127.0.0.1:38137 pid=399451
[backend] 状态 -> ready（127.0.0.1:38137 pid=399451）
[renderer] [ws-bridge] 后端 ready：port=38137 pid=399451
[renderer] [ws] 已连接 ws://127.0.0.1:38137/ws，发送 hello（app_version=0.1.0）
[backend] ... | INFO | dispatcher:124 - 连接 c_56ac4922 鉴权通过，session=458f24db...
[renderer] [ws] hello_ack ok=true session=458f24db408e4a088605f03a9c8e600e server_version=0.1.0
```

补充验证：后端独立探针确认 stdout **只有** `PET_READY {"port":...,"pid":...}` 一行（其余全在 stderr，主进程逐行转发并带 `[backend]` 前缀）；对非 READY 的 stdout 行主进程会打 warn（协议约定）。

### 3.2 真实对话闭环（xdotool 模拟：输入 → 用户气泡 → 助手逐字 → 情绪 → 定型）

操作：`xdotool` 点击输入框 → 键入 "你好小豆" → 回车。日志（渲染进程 console 转发）：

```text
[renderer] [chat] reply_start m_04acd24ac75742d98418bfba172149c6
[renderer] [chat] token "你好呀！"
[renderer] [chat] token "我是小豆"
[renderer] [chat] token "。"
[renderer] [chat] emotion -> happy（m_04acd...）
[renderer] [chat] token "今天过得"
[renderer] [chat] token "怎么样？"
[renderer] [chat] emotion -> thinking（m_04acd...）
[renderer] [chat] token "唔…" / "…让我想" / "想。"
[renderer] [chat] emotion -> neutral（m_04acd...）
[renderer] [chat] token "我" / "随时都在" / "这里陪你" / "哦。"
[renderer] [chat] reply_end full_text(36字) interrupted=false
```

- 跨片段切散的 `<emo:xxx>` 标签被正确剥离（token 中无标签残渣），emotion 事件按 happy→thinking→neutral 顺序到达；气泡按 full_text 定型为 36 字。
- 截图确认：用户气泡（蓝色右对齐）、助手气泡（白色左对齐 + 😊 占位 emoji）、顶部状态栏「待机 😐 neutral」均正确渲染。
- 共完成 3 轮真实发送（"你好小豆"、"testmsg"，及一次英文）。

### 3.3 崩溃自动重启（简单版）

`kill -9` 后端 Python 进程：

```text
[backend] 后端进程异常退出（code=null signal=SIGKILL）
[backend] 状态 -> starting（后端进程异常退出（code=null signal=SIGKILL），1s 后重启（第 1/3 次））
[renderer] [ws] 1s 后重连（第 1 次）→ 连接错误 → 2s 后重连（第 2 次）
[backend] 已拉起子进程 pid=396610：...
[backend] 状态 -> ready（127.0.0.1:37671 pid=396610）
[renderer] [ws-bridge] 后端 ready：port=37671 pid=396610
[renderer] [ws] 已连接 ws://127.0.0.1:37671/ws，发送 hello（app_version=0.1.0）
[renderer] [ws] hello_ack ok=true session=738d38fb...
```

新进程新端口新 token，渲染侧退避重连 + 重新 hello 全自动完成。

### 3.4 心跳健康

应用连续运行 15+ 分钟，WS 全程零重连、零判死日志（若无 pong 应答，10s 判死会触发重连）→ 30s ping / pong 链路正常。

### 3.5 退出清理（必测项，两次通过）

方式 A（向主进程发 SIGTERM，任务书口径）：

```text
[main] 应用退出：清理后端子进程…
[backend] 正在停止子进程 pid=396610（SIGTERM，3s 宽限）
[backend] 后端进程已退出（code=null signal=SIGTERM）
[backend] 状态 -> stopped
→ pgrep -f "python -m backend.main"：无残留（精确匹配复核）
```

方式 B（`pkill -x electron`）：清理日志同样出现，退出后 **Python 子进程零残留、electron 零残留、electron-vite 无残留**。

（注：本机还有另一个项目的 `python3 -m uvicorn backend.main:app` 进程，与草稿命令 `pgrep -f "backend.main"` 会误匹配；验证时已用 `python -m backend\.main$` 精确匹配排除。）

---

## ④ 需要用户肉眼确认的清单

> 应用正在运行（窗口在主屏底部居中，400x400；日志 /tmp/pet-dev.log）。可发消息复现下面各项。

- [ ] **1. 对话外观/布局**：气泡列表浮在企鹅下半身之上（400x400 窗口的空间限制），用户气泡蓝/助手气泡白，配色与可读性是否可接受？消息区 3 条以上出现滚动。
- [ ] **2. 逐字动画**：发送后助手气泡应逐字出现并带 ▍ 闪烁光标，`reply_end` 时光标消失（流总时长约 0.5s，很快；日志已证明逐字推送）。
- [ ] **3. 情绪变化**：回复过程中顶部状态栏应依次闪到「🤔 thinking」「😊 happy」，结束后停在「😐 neutral」；气泡头部 emoji 同步变化（本机无彩色 emoji 字体，图标为黑白轮廓，属预期）。
- [ ] **4. Enter 发送手感**：真人键盘（含中文输入法）输入后回车应发送；IME 候选确认的 Enter 不应误发（代码已做 isComposing 保护，但真人手感需你确认）。
- [ ] **5. 原能力回归**：聊天面板已加入可交互区域——点输入框/按钮不再穿透；宠物拖拽、悬停接管、Ctrl+Shift+F9/F10/F11 快捷键手感是否与之前一致。
- [ ] **6. 顶部状态栏位置**：情绪/状态栏位于窗口顶部居中，是否遮挡宠物或观感不佳。

---

## ⑤ 坑与遗留

### 测试环境坑（非应用缺陷，但值得记录）

1. **fcitx 拦截 xdotool 合成键盘**：输入法激活态下，`xdotool type` 的空格被吞、随后的 Enter 不触发发送；`fcitx-remote -c`（关闭输入法）后再按 Enter 即正常。真人键盘 + 中文 IME 不受影响（代码对组合态 Enter 有保护）。自动化回归脚本需先 `fcitx-remote -c`。
2. **X11 形状切换瞬间 press 丢 release**：自动化脚本在"鼠标进入 hitbox（触发 setClickThrough(false) 形状切换）的同瞬间按下"时，release 事件可能丢失，导致拖拽悬挂（窗口被后续鼠标移动拖着走）。真人操作间隔大，不易触发。**遗留改进**：linux.ts 可加"按钮状态看门狗"（如 500ms 无 pointerup 强制 endDrag）。
3. `pkill -x electron` 会连 GPU 进程一起 SIGTERM，主进程报 `GPU process isn't usable. Goodbye.`（FATAL 退出，非优雅路径）——但退出清理（before-quit → SIGTERM Python）仍已执行、无残留；仅日志噪音。

### 后端观察项（未改后端）

4. **Python 收 SIGTERM 为默认终止（exit=143）而非 uvicorn 优雅 shutdown（exit 0）**：115ms 退出、无残留，用于当前无状态 Echo 后端无影响；P2 引入 TTS 队列/落库后建议确认为优雅关闭（可能需后端配合，超出本次"不改后端"边界，仅记录）。
5. 后端 `load_history` / `interrupt` 已注册在 dispatcher 里部分可用，但前端 P1 未做历史回填 UI（重连后不回填消息，设计文档 §3.6 的"重连后 load_history"留待后续）。

### 前端遗留

6. 协议 TS 类型为**手工逐字段对齐** protocol.py（文件头已留 TODO：应改为从 Pydantic 生成，设计文档 §10 待办 #7）。
7. 生产态（PyInstaller 打包后）后端定位路径已预留（`resources/backend/backend(.exe)`），未实际打包验证。
8. Windows 子进程树清理（taskkill /T）与 SIGTERM 语义差异未实现/未验证（本期 Linux 验收；locate.ts 已按平台分支预留）。
9. 未建立 vitest 单测（协议序列化/重连退避/情绪映射等可单测点已列，P1 后续补）。
10. 消息列表不持久化（刷新/重启后清空，历史回填见第 5 条）；未做 `interrupt` 按钮（后端已支持，UI 未接）。
11. ChatPanel 的 dev 日志（token 逐条）仅 DEV 构建输出（`import.meta.env.DEV`），生产自动剔除。
