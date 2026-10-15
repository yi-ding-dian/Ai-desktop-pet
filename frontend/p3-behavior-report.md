# P3 步骤 2 —— 自主行为前端（执行器 / 窗口移动 / 环境上报）报告

> 日期：2026-10-14 ｜ 范围：设计文档 §4.5.5（前端执行器）、§5.1（窗口能力）、§7.4（时序）
> 结论：**"后端决策、前端执行"已在真机跑通**——真后端下发的 walk/look_around 被前端执行（窗口缓动移动 + 动画 + 回报），用户触摸/新对话可即时打断并回报 `interrupted:true`，环境上报（几何/系统空闲/宠物状态）随连接与事件流持续送达。
> 应用状态：为让主进程新代码生效，**已重启应用一次**（详见第 6 节"坑与说明"）；当前实例由后台运行，日志在 `/tmp/pet-p3-dev.log`。

---

## 1. 改动清单（前端）

### 主进程（electron/）

| 文件 | 类型 | 说明 |
|---|---|---|
| `electron/window/index.ts` | 改 | `WindowCapability` 增加 `moveTo(x,y,durationMs)` / `cancelMove()` / `getGeometry()`；新增 `WindowGeometry` / `MoveResult` 类型 |
| `electron/window/move.ts` | 新增 | 缓动移动器（`setInterval(16ms)` + easeInOutQuad 逐帧 `setBounds`；**单次 IPC 一次移动**；目标点 clamp 到目标显示器工作区；取消语义）＋ 几何读取 |
| `electron/window/linux.ts` / `win32.ts` / `darwin.ts` | 改 | 三平台接入 mover 与 `getGeometry()`（各 3 行接线，平台差异仍在 window/ 目录内） |
| `electron/ipc/channels.ts` | 改 | 新通道：`window:move-to`（invoke→MoveResult）、`window:move-cancel`、`window:get-geometry`、`system:get-idle-seconds`；新推送事件 `window:geometry-changed`；`PetBridgeApi` 增补 |
| `electron/ipc/index.ts` | 改 | 新 handler（含 `powerMonitor.getSystemIdleTime`）；窗口 `move`/`resize` → **debounce 1s** 推送 `geometry-changed` |
| `electron/preload.ts` | 改 | 白名单 bridge 增补 `window.moveTo/cancelMove/getGeometry/onGeometryChanged` 与 `system.getIdleSeconds` |

### 渲染进程（src/）

| 文件 | 类型 | 说明 |
|---|---|---|
| `src/shared/protocol/index.ts` | 改 | `EnvUpdateData` 扩展 `system_idle_seconds` / `pet_state`（+ `EnvPoint/EnvSize/EnvRect` 结构类型） |
| `src/modules/pet/behaviors/executor.ts` | 新增 | **行为执行器**：订阅 `behavior`/`state`；walk=moveTo+`setState('walking')`、nap/sleep=`setState('sleeping')` 保持时长、look_around=`playReaction('look_around')` 循环、未知行为按 duration 兜底；打断矩阵见第 3 节；统一回报 `behavior_done` |
| `src/modules/pet/behaviors/env-reporter.ts` | 新增 | 环境上报：连接就绪 + 几何变化（主进程已 debounce）+ `pet_state` 变化 + 每 30s 定时 |
| `src/modules/pet/behaviors/index.ts` | 新增 | 接线出口：`setupPetBehaviors` / `interruptPetBehavior` / `debugTriggerBehavior` / `subscribeBehaviorStatus` |
| `src/modules/pet/controller.ts` | 改 | 增加 `setPetState` / `playPetReaction`（供行为执行器驱动渲染器） |
| `src/modules/pet/index.ts` | 改 | 导出 behaviors 接线 API |
| `src/modules/pet/renderers/types.ts` | 改 | `PetReactionKind` 增加 `'look_around'` |
| `src/modules/pet/renderers/part-animation/animator.ts` | 改 | look_around 反应实现（2.8s：视线左右扫 + 头部轻摆，淡入淡出包络）——最小扩展，未动其它动画 |
| `src/modules/pet/PetView.tsx` | 改 | 摸头上报开关 `REPORT_TAP_HEAD_TO_BACKEND = true`（后端已实现）；调试键 **W**（walk 300px）/ **N**（nap 30s）走真实执行与回报路径 |
| `src/App.tsx` | 改 | `setupPetBehaviors` 接线；hitbox `pointerdown` → `interruptPetBehavior('用户触摸/抓取')`；状态栏显示"🐾 行为名（参数摘要）"与 W/N 提示 |

> 未动：`renderers/part-animation/` 的其它实现细节（penguin/config）、styles.css、chat/voice 域。

## 2. 设计要点

- **移动做在主进程**：渲染侧只发一次"移动到 (x,y)，时长 N ms"（单次 IPC），主进程 `setInterval(16ms)` 逐帧 `setBounds` + `easeInOutQuad`——WS 与 IPC 上都没有坐标流；取消（用户抓取/对话开始）在窗口层即时生效。
- **moveTo 语义**：同一时刻至多一个移动；新 `moveTo` 抢占旧移动（旧调用以 `completed:false` 结束）；目标点 clamp 到"目标矩形重叠最大的显示器"的工作区（防走出屏幕）。
- **打断矩阵**（任一触发：立即停移动/动画 → 回报 `{interrupted:true}`）：

  | 触发 | 来源 |
  |---|---|
  | 用户摸头/拖拽 | App 的 hitbox `pointerdown` → `interruptPetBehavior` |
  | 新对话开始 | WS `state` → thinking / speaking / dragging |
  | 引擎唤醒睡眠 | WS `state:idle` 且当前是 nap/sleep（用户回来） |
  | 新行为指令（防御） | 收到 `behavior` 时抢占旧行为 |

- **env 上报**：`{work_area, window_pos, window_size, system_idle_seconds, pet_state}`——`pet_state` 是"对话中静默"的旁路信号（引擎不读 chat_pipeline）；每次上报实时查询几何与 `powerMonitor.getSystemIdleTime()`。
- **渲染器复用**：walk/sleeping 直接用已有状态；仅新增 `look_around` 反应（不动渲染器结构）。

## 3. 校验结果

- `npm run typecheck`：**通过**（tsc node + web 两个工程，退出码 0）。
- 后端全量：224 passed（含本特性 18 个新用例）。

## 4. 真机实测（应用 + 真后端 + x11 工具）

环境：Deepin / X11（DISPLAY=:0），应用 dev 模式运行（日志转发到主进程 stdout，落于 `/tmp/pet-p3-dev.log`）；窗口用 `xwininfo` 读取位置取证。

### 4.1 宠物自己走动（引擎自主下发 → 前端执行 → 窗口真的动了）

```
[backend] 19:17:01 下发行为 b_84c38ed2 walk params={'direction': 'left', 'distance': 183, 'duration_ms': 1307}
[renderer] [pet/behavior] 收到行为 walk id=b_84c38ed2 params={"direction":"left","distance":183,"duration_ms":1307}
[renderer] [pet] state -> walking
[window/move] moveTo 完成 → 1392,251（1307ms）
[renderer] [pet/behavior] walk 移动结束：目标 x=1392 实际 x=1392 completed=true
[renderer] [pet/behavior] 行为 walk（b_84c38ed2）结束：interrupted=false，behavior_done 上报=true
[backend] 19:17:02 行为 walk 记账 energy -0.020 → mood=0.60 energy=0.73
```

xwininfo 前后对比（自主 + 调试两次）：窗口 x 从 **1575 → 1392（自主左移 183px）→ 920（打断实验前）**，y 恒 251（walk 只改 x）。

### 4.2 调试入口手动触发 walk（W 键）+ 位置取证

```
[renderer] [pet/behavior] 收到行为 walk id=dbg_mv80m5mj params={"direction":"right","distance":300,"duration_ms":2200}
[window/move] moveTo 完成 → 1520,251（2200ms）
[renderer] [pet/behavior] walk 移动结束：目标 x=1692 实际 x=1520 completed=true
```

- xwininfo 实测：**触发前 Absolute X = 1392 → 触发后 Absolute X = 1520**（窗口真的移动了）。
- 落点解释：目标 1692+400 的窗口矩形与主屏（0–1920）重叠更大 → clamp 到主屏工作区右缘 `1920-400=1520`（防走出屏幕生效；另一次目标 1820 的移动矩形进入副屏 → clamp 到 1920，跨屏行为符合设计）。

### 4.3 用户触摸打断（模拟摸头）

```
[renderer] 收到行为 walk id=dbg_mv80nur1 {direction:right, distance:300}
[renderer] [pet] state -> walking
[renderer] [pet/behavior] 行为 walk（dbg_mv80nur1）被打断：用户触摸/抓取
[renderer] [pet/behavior] walk 移动结束：目标 x=1200 实际 x=920 completed=false   ← 移动中途中止
[renderer] [pet] reaction -> pet ; tap_head（pet_event 上报=true）
[renderer] [pet/behavior] 行为 walk（dbg_mv80nur1）结束：interrupted=true，behavior_done 上报=true
[backend] 被摸头：mood=0.75 ... tap_head：已推 emotion(happy)
[renderer] [pet] ws emotion -> happy
```

### 4.4 新对话打断睡眠（真实发一条消息）

```
[renderer] 收到行为 nap id=dbg_mv80s38o {"duration_ms":30000}
[renderer] [pet] state -> sleeping
[renderer] [pet] ws state -> thinking                     ← 用户开始对话
[renderer] [pet/behavior] 行为 nap（dbg_mv80s38o）被打断：新对话/拖拽（state=thinking）
[renderer] [pet/behavior] 行为 nap（dbg_mv80s38o）结束：interrupted=true，behavior_done 上报=true
[renderer] [pet/behavior] env_update（pet_state=thinking）：pos=1216,251 idle=0s state=thinking
[renderer] [chat] reply_start ... reply_end（对话正常，口型驱动可见）
```

### 4.5 环境上报与其它

- `env_update（连接就绪）：pos=760,592 idle=8s state=idle`；此后随几何变化（拖拽/移动）与每 30s 定时持续上报（日志可见 `idle=0/4/8/10/20/43s` 变化，来源 `powerMonitor.getSystemIdleTime()`）。
- 引擎超时兜底实战：首轮实测曾出现引擎下发→前端未执行→8s 警告并继续（原因见第 6 节，已修复复测）。
- 用户在场期间手动拖拽宠物亦见日志（`drag start @ 933,753` → `drag end`），拖拽与行为互斥正常。

## 5. 需要用户肉眼确认（清单）

1. **走动是否自然**：步态颠步（walking 姿态）与窗口缓动的配合是否顺滑、无明显跳变；单步 120–320px、速度约 140px/s 是否合适。
2. **打盹频次与打扰感**：默认空闲 10–40s 一次行为；请在正常办公 10–30 分钟体感"是否烦人"。若偏打扰：可 `[behavior].enabled=false` 关闭，或设 `quiet_hours=["工作时段"]`。
3. **张望（look_around）是否看得出**：视线左右扫 + 头部轻摆 2.8s 循环——幅度是否够明显又不怪异（幅度在 animator.ts 的 `0.65` / `3.2` 两个系数上可调）。
4. **睡眠观感**：nap/sleep 都是闭眼睡觉姿态（当前不区分）；白天精力高时基本不睡、深夜/久坐离开才睡——观感是否符合期待。
5. **被打断的观感**：摸头/打字时宠物是否"立刻停下"，有无半帧抖动或残留移动。
6. **摸头反应**：点击宠物 → 弹跳 + 心形 + happy 表情（且后端已收到 pet_event，心情上升）。
7. **调试键**：窗口聚焦时按 **W** 走 300px、**N** 打盹 30s（底部状态栏有提示；输入框内按键不拦截）。
8. **边界行为**：贴着屏幕边缘连续走动时，是否出现"卡在边缘原地不动"的别扭感（当前会 clamp 在边缘）。

## 6. 坑与说明（含对用户的影响）

- **应用已重启一次**：窗口能力 `moveTo` 在主进程（IPC 层），HMR 无法热更，按任务预案执行：`pkill -f "[e]lectron-vite dev"` + 清理残留 electron 进程 → **后台** `npm run dev`（日志 `/tmp/pet-p3-dev.log`）。副作用：原终端里的 dev 进程已不在，如需回到自己的终端运行请自行重启（当前实例工作正常，可继续使用）。
- **渲染进程 bug（已修复）**：首轮真机中"引擎下发、前端无动作"，根因是执行器只订阅了 `state` 漏了 `behavior`；修复后 HMR 生效并复测通过。此期间引擎按超时兜底继续运转（也顺便验证了兜底的健壮性）。
- **xdotool 模拟按键的两个环境坑**（供后续真机自动化参考）：① 点击必须落在窗口交互形状（hitbox/聊天面板/状态栏）内才会聚焦窗口；② 输入框聚焦时 PetView 的调试键被"输入场景不拦截"规则屏蔽（设计如此）。手动验证无此问题。
- **调试点坐标**：调试触发的一次被取消移动的目标 x 与落点差异较大，是因为点击/取消发生在缓动早期（`completed:false` 已如实回报，不视为 bug）。
- **遗留**：nap 与 sleep 视觉不区分（复用 sleeping）；`look_around` 时长与反应周期（2.8s）对齐后循环播放，若后端把 duration 调很大（>15s）前端会 clamp 到 15s；多显示器工作区 clamp 采用"重叠最大的显示器"，如未来要精确跨屏走动可改用目标点所在显示器判定。
