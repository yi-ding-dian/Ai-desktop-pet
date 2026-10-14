# 宠物形象原型报告（部件动画宠物「小豆」）

> 日期：2026-10-14 17:5x–18:0x；分支工作区未提交。
> 形象：简约扁平矢量风企鹅「小豆」；纯 SVG + 代码动画，**零新依赖**。
> 应用未重启，全程 HMR 生效（`/tmp/pet-dev.log`）；未动 backend/、代码设计文档/、record.md。

---

## ① 实现说明（架构）

按设计文档 §5.3 把"Live2D 渲染"落地为**可插拔渲染器**：接口定义完整，部件动画渲染器是第一个实现，Live2D 渲染器只需实现同一接口并在工厂注册，调用方零改动。

```text
frontend/src/modules/pet/
├── index.ts                    域出口（PetView + 渲染器工厂/类型）
├── PetView.tsx                 React 集成层：挂载渲染器 / WS 订阅 / 摸头手势 / 调试键
└── renderers/
    ├── types.ts                PetRenderer 接口（mount/unmount/setEmotion/setState/setMouth/playReaction/dispose）
    ├── index.ts                createPetRenderer() 工厂 —— 换渲染器的唯一开关（'live2d' 分支已留 TODO 位）
    └── part-animation/         第一个实现：程序化 SVG + rAF（零依赖）
        ├── config.ts           造型参数（唯一事实来源：尺寸/位置/颜色/心形粒子）
        ├── penguin.ts          SVG 分层绘制（只画部件）+ 动态嘴形路径生成
        ├── emotion-map.ts      情绪 → 部件姿态映射表（8 情绪）
        ├── animator.ts         动画驱动（缓动/微行为/状态叠加/反应，只算数不碰 DOM）
        └── index.ts            PartAnimationRenderer：生命周期 + rAF 循环 + 逐帧写 DOM（applyFrame）
```

**关键设计点**

- **渲染循环独立于 React**（设计文档 §5.3）：rAF 在渲染器内部自驱，React 只负责挂载/卸载与指令转发；帧更新不触发任何 React 重渲染，DOM 部件全程复用（仅改属性）。
- **接口为 Live2D 留位**：`PetRenderer` 的方法集与 Live2D 能力一一对应（`setMouth` ≈ `ParamMouthOpenY`/`speak()`；`playReaction` ≈ motion 单次播放）；`renderers/types.ts` 顶部注释说明了替换路径。
- **集成**：`App.tsx` 的 🐧 占位替换为 `<PetView client={wsClient} />`，hitbox 容器保留为渲染器挂载点；pet 域订阅 `emotion`/`state` 的方式与 chat 域一致（`client.on(...)`，见 `PetView.tsx`）。
- **摸头**：点击（位移 < 6px 判定，区别于拖拽）→ 渲染器 `playReaction('pet')`（弯眼笑 + 弹跳弹簧 + 心形粒子 + 脸红）。
  ⚠ 上报后端 `pet_event{tap_head}` 的代码路径已留，但**默认关闭**（`PetView.tsx` 的 `REPORT_TAP_HEAD_TO_BACKEND`）：实测上报会收到后端 `NOT_IMPLEMENTED 事件类型 pet_event 尚未实现`（Echo 流水线），chat 域会显示错误气泡、状态栏出现 ⚠ 文本；后端实现该事件后把开关置 true 即可。
- **口型**：`setMouth(0–1)` 已留接口；`state=speaking` 且未被外部驱动时渲染器内置"模拟说话"口型兜底（口型振荡），保证状态可见。

---

## ② 部件与参数结构

部件（图层从下到上）：**呆毛 → 翅膀×2 → 脚×2 → 身体 → 情绪色偏层 → 肚子 → 头顶高光 → 眼睛×2（眼白+瞳孔+高光 / 笑眼弧 / 生气眉 / 难过眉）→ 嘴 → 腮红×2 → 心形粒子×2**。

参数全部集中在 `part-animation/config.ts`（`PENGUIN_CONFIG`）：

| 参数组 | 说明 |
|---|---|
| `body / belly / headHighlight` | 身体、肚子、头顶高光的椭圆几何（cx/cy/rx/ry，400×400 viewBox 坐标） |
| `hair` | 呆毛路径 + 粗细 + 旋转根部 |
| `wings.left/right` | 翅膀椭圆 + 倾斜角 + 旋转轴心（根部） |
| `eyes` | 双眼位置、眼白半径、瞳孔半径/内偏、高光、笑眼弧路径、两套眉毛路径与粗细 |
| `mouth` | 嘴的基准宽/最大开合高度（形状逐帧由 宽/弯度/开合 三参数生成） |
| `blush / feet` | 腮红、脚的形状与倾斜 |
| `hearts` | 心形路径 + 每个粒子的锚点/延迟/摆动幅度 |
| `colors` | 全部配色（身体渐变、肚子、翅膀、呆毛、瞳孔、嘴、脚、腮红、眉） |

窗口构图：viewBox 400×400 → 显示容器 **208×208 @ (96,34)**（窗口 400×400 内），企鹅本体显示约 123×167px。

---

## ③ 情绪 → 部件参数映射（怎么调）

映射表在 `part-animation/emotion-map.ts` → `EMOTION_POSES`（每种情绪一组 `PetPose` 目标值，含强度插值 `resolveEmotionPose(emotion, intensity)`）。

| 情绪 | 眼形 | 眉 | 嘴 | 腮红 | 身体 |
|---|---|---|---|---|---|
| neutral | 圆眼 | – | 微弯小喙 | 淡 | – |
| happy | 弯月笑眼 | – | 张嘴笑（上翘） | 深 | 翅膀上抬、呆毛后甩 |
| sad | 眼半垂、视线下 | 八字眉 | 嘴角下垂 | 无 | 呆毛耷拉、下沉、冷色偏 |
| angry | 眯眼 | 怒眉（外高内低） | 咧嘴 | 红（变色） | 翅膀炸起、呆毛竖立、红紫偏 |
| surprised | 瞪大 + 瞳孔放大 | – | O 形大张 | 淡 | 弹起、呆毛竖直、翅膀张开 |
| shy | 弯眼 | 淡八字眉 | 抿嘴微笑 | 最浓 | 视线躲开、微微歪头 |
| thinking | 视线右上飘 | – | 抿嘴微撇 | 淡 | 歪头 7°、呆毛前倾 |
| sleepy | 几乎闭合、视线下 | – | 小哈欠 | 中 | 下沉、呆毛耷拉、紫偏 |

改法：
- **调表情**：改 `EMOTION_POSES` 里对应条目（或改 `NEUTRAL_POSE` 基线）；字段含义见 `PetPose` 的逐字段注释。
- **调造型**：改 `config.ts`（尺寸/位置/颜色），无需碰动画代码。
- **调动画手感**：`animator.ts` 顶部常量（缓动时间常数 FAST/SLOW_TAU、眨眼时长、呼吸周期 2.6s、摇摆周期 3.9s、弹跳弹簧参数、反应时长 0.9s）。
- **状态叠加**：`animator.ts` 的 `applyStateModifiers`（thinking 眼睛上飘、sleeping 闭眼、dragging 睁大眼+翅膀张开、speaking 口型振荡、walking 颠步）。

**运行时调试键**（窗口聚焦时，输入框内不拦截）：按住 `M` = 口型开合（验证 setMouth）；数字 `1–8` = 预览 8 种情绪，`0` = 回 neutral。窗口级 F9/F10/F11 调试快捷键未改动。

---

## ④ 验证结果

### 已通过（自动化）

1. `npm run typecheck` 通过（tsconfig.node + tsconfig.web 全量）。
2. HMR 生效、无报错：日志 `[pet] renderer(part-animation) mounted`，StrictMode 双挂载安全（dispose/mounted 成对出现）。
3. **交互矩形与新形象匹配**：`[pet] interactive rects = [{96,34,208,208}, chat, statusbar]`；X11 侧 `xwininfo -shape` → `Window shape extents: 368x357+16+34`（= 三个矩形的并集包围盒，即宠物形状已从旧 260×260 更新为 208×208）。
4. 置顶状态保持：`_NET_WM_STATE = _WM_STATE_ABOVE, _STAYS_ON_TOP`。
5. **离屏截图验证（29 张）**：把渲染器打包进独立 Electron offscreen 预览程序逐一截图（不影响运行中的应用）。8 种情绪 × 浅/深背景、状态（thinking/speaking/sleeping/dragging/walking）、口型、摸头反应全部有符合预期的部件差异。
   - 拼图：`/tmp/pet-preview/emotions-8.png`（8 情绪）、`/tmp/pet-preview/states-6.png`（状态+反应）
   - 单张：`/tmp/pet-preview/shots/`（light-*/dark-*）
6. 微行为在预览中动态确认：呼吸（2.6s 缩放）、摇摆、随机眨眼（2–6s）、摸头弹跳（弹簧）、心形粒子飘出。
7. **摸头链路（合成事件）验证**：锁屏无法注入真实鼠标，用一次 HMR 临时注入合成 `PointerEvent` 走通完整判定链路（验证后已移除）——
   纯点击 → 日志 `[pet] reaction -> pet` + `tap_head`；带 40px 位移的按下/移动/抬起 → 不触发摸头（拖拽判定正确）。
   即"判定 → 反应 → 上报"代码路径已通；仅真机鼠标事件经 X11 到达窗口这一层待解锁后由点击确认。

### 待用户肉眼确认（⚠ 当前屏幕处于锁屏状态，桌面交互无法自动验证）

锁定原因：会话期间屏幕被 Deepin 锁屏覆盖——xdotool 的鼠标 hover/点击与 Ctrl+Shift+F9/F10/F11 均被锁屏拦截（已验证注入无效），因此以下项需要在解锁后确认：

- [ ] **1. 形象与动态（10s）**：宠物是否为矢量企鹅、呼吸/摇摆/眨眼是否自然（对比截图看真机效果）。
- [ ] **2. 真机点击摸头（10s）**：左键单击企鹅 → 弯眼笑 + 弹跳 + 心形粒子；日志应出现 `[pet] reaction -> pet` 与 `[pet] tap_head（本地反应；pet_event 上报暂缓…）`。
      复验命令（解锁后）：`DISPLAY=:0 xdotool mousemove 960 730 click 1 && grep tap_head /tmp/pet-dev.log`
      （960,730 = 窗口 (760,592) + 宠物中心 (200,138)；窗口若被拖动过请相应换算）- [ ] **3. 穿透与拖拽不变（20s）**：宠物周围空白点击应穿透到桌面；按住宠物拖动应跟手（交互矩形已随形象缩小到 208×208，抓取手感是否合适）。
- [ ] **4. 表情触发（30s）**：与后端对话触发 emotion 事件后，宠物表情应切换（如"说点开心的"→ happy 弯眼笑）；`thinking`/`speaking` 状态反应（歪头眼神、嘴动）。
- [ ] **5. 调试键（10s）**：按住 M 嘴开合；按 1–8 逐个预览情绪（好看吗/到位吗——这是主观项，随时可要求我按你的意见调 `emotion-map.ts`）。
- [ ] **6. 审美主观项**：企鹅造型（比例/配色/呆毛/腮红位置）是否合眼缘；动作幅度（摇摆/弹跳）是否过大或过小。

---

## ⑤ 坑与遗留

### 坑（本次踩到的）

1. **锁屏 → 屏幕截图与渲染双受影响**：会话中途屏幕进入锁屏。ffmpeg x11grab 抓不到被锁屏遮挡的窗口（抓到的只是桌面壁纸）；窗口遮挡还导致 Chromium 把 rAF 降到 ~22fps，早期截图"看起来没变化"其实是**合成节流假象**（诊断脚本读 DOM 属性确认动画值 0.000/1.000 完全正确后改用 offscreen 渲染模式解决，60fps + capturePage 可靠）。
2. **离屏预览是本次验证的关键手段**：`esbuild` 打包渲染器 → 独立 Electron offscreen 窗口截图。锁屏环境下唯一可靠的视觉验证方式；脚本在 `/tmp/pet-preview/`（`main.js` 全量 28 张 / `shot-one.js` 单张 / `diag*.js` 诊断），**在 /tmp 易失**，如需长期保留请告知搬到项目内。
3. 相对导入层级：`part-animation/` 下到 `shared/` 是 4 级（`../../../../shared/protocol`），首次编译报错已修正。
4. StrictMode 下挂载 effect 会执行两次：渲染器 mount 内部先 `unmount()`（幂等重建），日志中 dispose/mounted 成对即证据。
5. **hitbox 从 (70,70,260,260) 改为 (96,34,208,208)**：形象变小后交互矩形同步收紧（任务要求），X11 形状随之更新（已核验）。旧的 verify-report 中形状数字自此失效，以本报告为准。
6. **pet_event 上报 → 后端 NOT_IMPLEMENTED**：摸头事件上报后，chat 域把后端 error 渲染成红色错误气泡、状态栏出现 ⚠ 文本（并撑高状态栏矩形）。已改为默认不上报（开关保留）；顺带用一次入口文件 full-reload（临时注释触发，随即还原，`main.tsx` 无残留）清掉了该错误状态。
7. 验证期间观察到底层后端进程曾被 SIGKILL 一次并自动重启成功（发生于并行后端开发改动期间，非本次前端改动引起；重启后 WS 自动重连正常，属 P1 已实现的韧性）。

### 遗留（未做/待接）

- **真实桌面交互复验**：点击摸头、穿透/拖拽手感、F9/F10/F11——待解锁后按 ④ 清单确认（代码路径与预览截图均已验证，仅缺真机交互）。
- **TTS 口型**：`setMouth` 接口已留；Phase 2 接音量包络/WordBoundary 即可，不需改渲染器。
- **性能降帧**：设计文档 §5.3 的"无交互降帧 30→10fps"未做（当前常驻 60fps；单 SVG 负担很小）；窗口最小化时 rAF 由浏览器自动暂停（已满足"隐藏时暂停"）。
- **反应种类**：仅 `'pet'`（摸头）；`PetReactionKind` 类型与 `playReaction` 分发已预留 poke/hug 等扩展位。
- **pet_event 后端闭环**：前端发送路径已就绪但默认关闭（见 ① 说明）；后端实现 `pet_event` 流水线后，将 `PetView.tsx` 的 `REPORT_TAP_HEAD_TO_BACKEND` 置 true 即可恢复上报。
- **Windows/macOS**：交互逻辑收敛在 electron/window/，但新形象的形状/尺寸表现未在非 X11 平台回归。
- **深色桌面下**：身体深蓝在深色壁纸上对比度略降（预览已确认可辨）；若用户觉得不够亮，改 `config.colors.bodyTop/bodyBottom` 即可。
