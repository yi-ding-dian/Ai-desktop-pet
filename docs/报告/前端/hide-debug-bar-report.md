# 隐藏调试状态栏 — 实施报告

日期：2026-10-15 11:10
范围：仅 `frontend/`（渲染侧 + Electron 主进程快捷键注册）；未动 backend、未提交版本控制。

## 1. 状态

完成。默认状态下顶部状态显示（`思考中 😐 happy` 这类）与底部调试栏（`后端/WS/穿透/置顶/hitbox/F9-F11…`）**均不渲染、完全不占界面**；`Ctrl+Shift+D` 一键唤出 / 再按隐藏。宠物本体、输入框、发送/停止按钮、气泡、拖拽/穿透/F9-F11/W/N 交互均不受影响。

## 2. 改动清单

| 文件 | 改动 |
| --- | --- |
| `frontend/src/App.tsx` | 新增 `debugBarVisible` 状态（默认 `false`）；顶部 `.pet-status-bar` 与底部 `.status-bar` 改为**条件渲染**（隐藏时不挂载 DOM、不挂 ref）；新增两路切换：渲染侧 `keydown`（Ctrl+Shift+D）+ 主进程事件订阅；交互矩形上报 effect 依赖加入 `debugBarVisible`，显隐时重建 ResizeObserver 并重报（隐藏时不再上报状态栏矩形） |
| `frontend/electron/ipc/channels.ts` | 新增事件常量 `IPC_EVENTS.WINDOW_TOGGLE_DEBUG_BAR`（主→渲染）；`PetBridgeApi.window` 新增 `onToggleDebugBar(cb)` |
| `frontend/electron/preload.ts` | 实现 `onToggleDebugBar`（订阅上述事件） |
| `frontend/electron/main.ts` | 新增 `SHORTCUTS.toggleDebugBar = 'Control+Shift+D'`（globalShortcut，与 F9/F10/F11 同风格）；触发时仅向渲染侧转发"翻转"事件 |
| `frontend/src/styles.css` | 仅注释更新（两处状态栏标注"默认隐藏，Ctrl+Shift+D 唤出"），样式规则未变 |

设计要点：**显隐状态只由渲染侧持有**（单一状态源，不会漂移）；主进程只转发翻转事件。隐藏用条件渲染而非 CSS 隐藏——彻底不占 DOM/不做交互矩形上报。

## 3. 快捷键

- `Ctrl+Shift+D`：切换顶部状态显示 + 底部调试栏的显隐（一个开关控制两者）。
- 两条触发路径（互补）：
  1. **渲染侧 keydown**（窗口有键盘焦点时生效，如点过输入框之后）——**当前运行实例已可用**；
  2. **主进程 globalShortcut**（穿透/失焦时也生效）——代码已就绪，**需重启一次 Electron 后注册生效**（dev 脚本 `electron-vite dev` 无 `--watch`，主进程不热更；本次按约束未重启）。

## 4. 验证

- `npm run typecheck`（node + web 两个 tsconfig）通过。
- HMR 日志无报错（`/tmp/pet-dev.log`；仅 GPU/libva 既有噪音）。新增 API 对旧 preload 缺失场景做了可选调用防御（`onToggleDebugBar?.()`），当前实例无异常。
- 交互矩形日志佐证：隐藏时 `interactive rects` 为 2 项（hitbox + 对话面板），唤出后为 3 项（+状态栏），再按回 2 项。
- 截图（x11grab 真机抓屏，窗口 400×400 区域；截图里露出的浅色/黑色内容是透明窗口后方的桌面，属正常透明效果）：
  - 默认隐藏（红框区域全部消失、输入框/按钮位置无错位无空洞）：`frontend/hide-debug-bar-shots/debug-bar-hidden.png`
  - Ctrl+Shift+D 唤出（顶部"待机 😐 happy"+ 底部完整调试栏重现）：`frontend/hide-debug-bar-shots/debug-bar-shown.png`
  - 再按一次隐藏：`frontend/hide-debug-bar-shots/debug-bar-hidden-again.png`
  - 改动前参照：`~/Pictures/Screenshots/截图_ai-desktop-pet_20261015110056.png`（用户圈注的顶部 + 底部状态显示）

## 5. 坑与遗留

1. **主进程改动需重启才生效**：`main.ts` / `preload.ts` 的新增部分在当前运行实例中尚未加载（约束要求不重启）。表现：当前实例 `Ctrl+Shift+D` 依赖窗口有焦点；重启后全局快捷键（穿透/失焦场景）自动生效。渲染侧已做旧 preload 兼容，无报错。
2. **顶部状态显示原先一直显示**（`思考中 😐 happy` 等，开发向信息），已纳入同一开关默认隐藏。
3. **错误提示随调试栏隐藏**：`⚠ code: message`（WS error）现在默认不可见，排障时需先 `Ctrl+Shift+D` 唤出。如果后续希望"出错时轻量提示用户"，建议走宠物气泡/表情而非状态栏。
4. **快捷键占用风险**：Ctrl+Shift+D 由 globalShortcut 全局注册（重启后），会抢占其它应用中的同组合键；启动日志若出现"注册失败（可能被系统/其它程序占用）"可换键（如沿用 F 键族 `Control+Shift+F12`）。正常 X11 下 globalShortcut 会拦截按键、渲染侧收不到，不会双触发；若个别环境出现"按一次无变化"（双路径各翻转一次互相抵消），可去掉渲染侧 keydown 只留全局快捷键。
5. 交互矩形（X11 形状穿透）在状态栏隐藏时不再包含其区域——符合预期：状态栏 `pointer-events: none`，隐藏后该区域完全穿透到桌面。
6. 本次验证方法（可复现）：`xdotool windowactivate --sync <宠物窗口id> && xdotool key --clearmodifiers ctrl+shift+d`，配合 `ffmpeg -f x11grab` 抓窗口区域；窗口 id 可用 `xdotool search --pid <electron 主进程 pid>` 从窗口名「AI 桌面宠物」定位。
