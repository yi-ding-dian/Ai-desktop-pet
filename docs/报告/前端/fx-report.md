> ℹ️ 该域已于 2026-10-17 改名 ball-animation（原名 fx 是命名规范点名的反例）；本文为历史报告，正文保留当时的目录与常量名。

# 魔法球捕获动画（fx 域）—— 实施与验证报告

日期：2026-10-15 ｜ 环境：Deepin DDE + X11（KWin）、主屏 1920x1080、DPR=1 ｜ Electron 33 / electron-vite dev
范围：`frontend/electron/fx/`（新域：index / config / anchor / template-match）、`electron/{main,preload}.ts`、`electron/tray/index.ts`、`electron/ipc/channels.ts`、`frontend/src/fx/`（动画页）、`src/modules/pet/renderers/*`（被抓/被放反应）、`electron.vite.config.ts`、根目录 `fx.html`、`resources/tray-anchor-template.png`、`electron-builder.yml`

---

## 1. 实现

### 1.1 方案（沿革）

- 最初设想"全屏透明动画层"——**用户否决**（会覆盖用户其它操作）；最终采用 **球窗方案**：
  **一个 360×360 的透明小窗（"球"本体），飞行 = 主进程沿二次贝塞尔拱线逐帧 `setBounds` 移动这个小窗**。
- 视觉与运动设计整体移植自参考实现 `svn-git/src/client/shell/magic-flight.tsx`（贝塞尔拱线 +
  easeInOut 三次缓动 + 星屑尾迹 + 抵达爆散），按球窗尺寸做紧凑化适配。

### 1.2 球窗技术参数（`electron/fx/index.ts`）

| 项 | 值 | 说明 |
|---|---|---|
| 尺寸 | 360×360 | `FX_CONFIG.ballWindowSize`（上限 ~400，绝不全屏） |
| 窗口 | `transparent + frame:false + alwaysOnTop(screen-saver 层级) + skipTaskbar + type:'toolbar' + focusable:false + show:false` | 与宠物窗同源；toolbar 防 DDE Dock 出格子；screen-saver 层级保证球盖在宠物上 |
| 鼠标 | `setIgnoreMouseEvents(true)` **全点击穿透** | 球飞过/停在托盘都不挡用户操作（已实测，见 §3.5） |
| 显示 | `showInactive()` | 不抢焦点 |
| 生命周期 | 懒创建；动画结束 `hide()` 复用（下次秒开）；`will-quit` 时 `destroyFx()` 销毁 | |

### 1.3 时序编排（主进程为唯一指挥；`runHideAnimation` / `runShowAnimation`）

**隐藏**（总耗时实测 ≈ 2.05s，`[fx] t=…ms` 日志逐段可查）：

| 阶段 | 时长 | 动作 |
|---|---|---|
| ① 飞行 | 780ms | 球窗（空载）沿拱线：托盘锚点 → 宠物窗口中心；拖尾 + 星屑 |
| ② 抵达爆散（捕获） | 420ms | 球窗播爆散（30 粒子 + 收敛光晕 + 扩散环）；宠物窗口**原地**缩小到 0.2×；渲染侧播 `captured`（缩小+挣扎抖动）并**中断当前自主行为** |
| ③ 回程 | 620ms | 球窗与缩小态的宠物窗**沿同一条拱线同步飞行**回托盘锚点（单计时循环，无双计时器错帧）；球窗进入载宠模式（球内小兔剪影） |
| ④ 收尾 | 180ms | 宠物 `hide()` → 球窗淡出 → 球窗 `hide()` → 解锁 |

**显示**（反向，总耗时实测 ≈ 1.42s）：球窗（载宠剪影）沿拱线从托盘飞到**原位**中心（780ms）→
宠物窗以"原位缩小态"出现 → 爆散 + 放大归位（420ms）+ 渲染侧 `released`（弹性回弹+落地 Q 弹）→ 淡出（180ms）。
原位来自隐藏时记录的 stash（`stashedBounds`），实测精确恢复（误差 0）。

### 1.4 边界与兜底（全部实测）

- **锁**：动画中再次触发显/隐 → 直接忽略（日志 `动画进行中，忽略本次隐藏请求`）；
- **退出不播动画**：动画域不参与退出链路，`will-quit` 直接销毁球窗；
- **兜底**：等 fx 页就绪有 2.5s 超时（超时降级为瞬时 show/hide）；整流程 6s 看门狗；
  每个阶段 `await` 后检查中止，`try/catch/finally` 保证**结果语义**（隐藏一定 hide、显示一定 show 且归位）；
- **异常降级**：主进程重启后旧 preload 无 fx 方法时渲染侧静默跳过（可选链）。

### 1.5 动画页（`fx.html` + `src/fx/main.ts`，第二渲染入口）

- Canvas 2D **零素材**程序化绘制；DPR 缩放；帧步长按 60fps 基准伸缩（参考的固定步进语义）；
- 状态机：`idle → flight → burst → fade`（指令：`reset / flight{cargo} / capture-burst{holdMs} / release-burst / fade-out`）；
- **方向感**：球固定在窗中心，尾迹/星屑按 `window.screenX/Y` 差分做**反向平移**（世界固定）——
  "球飞过、身后留下星屑"的观感不需要主进程喂方向（差分即得）；
- 视觉：核心光球（白→#7dd3fc 渐变，照参考 17px 光点）+ 紫色外晕；尾迹 8 点紧凑化（细→粗 0.6→4.2、
  青→白后 28% 转白、shadowBlur 发光）；星屑每帧 3 颗（随机速度 + vy 0.25 下坠、寿命 0.35~0.65s、阻尼 0.98/帧）；
  爆散 = 30 径向粒子 + 收敛光晕（26px→收缩）+ 扩散环（6→32px）；颜色池 `#7dd3fc/#a78bfa/#f0abfc/#fda4af/#fff`（与参考一致）；
  载宠时球 ×1.5 并在球内画小兔剪影（轻微摇摆 = 挣扎感）。

### 1.6 渲染侧"被抓/被放"反应

- `PetReactionKind` 扩展 `'captured' | 'released'`（向后兼容，其余 kind 静默忽略）；
- **glb-model**（默认渲染器）：`pose.ts` 新增 `capturedReactionPose`（0.6s：快速缩小 14% + 5Hz/7Hz 双频挣扎抖动）
  与 `releasedReactionPose`（0.95s：欠阻尼弹回 0.8→过冲→1.0 + 两次衰减落地弹跳 + 落稳微摆）；
- **part-animation**：`animator.ts` 同名两段（体态缩放 + 旋转抖动；released 另给弹簧一次 Q 弹）；
- **three-d**：显式 no-op（注释说明，向后兼容）；
- 触发链路：主进程 `pet:fx-reaction` → preload `window.pet.fx.onPetReaction` → PetView 订阅转 `renderer.playReaction`；
  收到 `captured` 时**同时中断当前自主行为**（`interruptPetBehavior('被魔法球捕获')`，语义同"用户抓取"——
  防 walk 的窗口缓动与 fx 动画抢 `setBounds` 造成抖动；实测验证：进行中的 look_around 被正确中断）。

### 1.7 接线

- `tray/index.ts`：菜单"隐藏/显示宠物"、托盘单击 → `runHideAnimation/runShowAnimation`（结果语义不变）；
- `main.ts`：Alt+F4 等 close 拦截 → `runHideAnimation`（退出时 `quitting` 放行不变）；`second-instance`
  在窗口隐藏时走显示动画；`will-quit` → `destroyFx()`；dev 排障自检钩子 `PET_ANCHOR_SELFTEST`。

### 1.8 托盘锚点"屏幕像素自动定位"（anchor.ts + template-match.ts）

**动机**：球必须从**托盘兔头图标**腾起/收回；但图标位置无任何 API 可查（Electron `tray.getBounds()`
仅 Win/macOS；SNI 协议不含位置；DDE 无公开查询），且托盘图标增删/顺序/分辨率变化都会让写死坐标漂移。

**流程（每轮隐藏/显示动画开始前，与 fx 页就绪等待并行执行）**：

1. **抓屏**：`desktopCapturer.getSources({types:['screen'], thumbnailSize: 主屏逻辑尺寸})`
   ——**Linux/X11 实测可用**（抓图含 DDE Dock 与托盘图标），原生无子进程；
   异常/空图时回退 `ffmpeg -f x11grab` 子进程抓图（环境自带 ffmpeg，不新增依赖）；
2. **模板匹配（两级判别）**：
   - 灰度 **NCC** 粗到细（1/4 降采样全宽粗定位 → 原分辨率邻域精定位），取 **top-6 候选**（NMS 去重）；
   - **中心加权 RGB 颜色校验**精选：综合分 = NCC × 颜色分（中心权重 0.35–1.0，削弱背景稀释）；
   - 实测必要性：纯灰度 NCC 会把 Dock 上"白/蓝圆的浏览器图标"误配成兔头（NCC 0.78 > 阈值），
     颜色分把误配压到综合 0.63（< 阈值 0.75），而真实兔头综合 1.00；
   - 搜索带限定 Dock 条（屏底 90px）+ 位置合理性校验（x 距屏幕边缘 ≥40px）；
3. **输出**：命中 → 图标中心（screen 坐标）；**未命中/低置信/抓屏失败 → 兜底配置 TRAY_ANCHOR**
   （实测值 1334,1071，可用 `PET_TRAY_ANCHOR="x,y"` 覆盖）——**任何失败都不影响动画播放**；
4. **日志**：`[fx] 锚点定位：自动命中 (1334,1068) 置信 1.000（耗时 129ms）` /
   `...模板未命中，用兜底 (…, …)`。

**性能实测**：定位总耗时 129–196ms（含 desktopCapturer 抓屏；冷启首次 ~350ms），纯匹配 ~60ms ——
满足 <300ms 目标；与 fx 页就绪等待并行，不增加"按下到球起飞"的额外延迟。

**模板**：`resources/tray-anchor-template.png`（24×24，从实测截图裁出的**真实渲染兔头**，中心 = 图标中心），
经 electron-builder `extraResources` 落 `process.resourcesPath/tray-anchor-template.png`；
备用模板 = 托盘图标素材（`build/icon.png` / `resourcesPath/tray-icon.png` 缩 24×24）。
**维护**：托盘图标外观更新后主模板会失配（自动降级到备用模板/兜底坐标）——
重新裁制方法：全屏截图（`ffmpeg -f x11grab`）→ 裁托盘区放大定位图标像素中心 → 以中心裁 24×24 → 覆盖素材文件。

**离线自检**（dev/排障）：`PET_ANCHOR_SELFTEST=/path/shot.png` 对指定截图跑匹配并打印全部候选
（ncc/颜色/综合 三列，便于调参）；`PET_ANCHOR_SELFTEST=1` 启动时抓屏定位并保存抓屏图到
`/tmp/pet-anchor-capture.png`。注意：自检在 `whenReady` 时执行、**早于托盘注册**，抓屏里可能还没有
兔头图标（会显示"未命中/兜底"属预期）；真实动画路径中托盘必然已注册。

**已知局限（有兜底，不影响动画）**：托盘图标必须**在抓屏图里可见**——DDE Dock 若有窗口全屏遮挡 /
面板自动隐藏等，会抓不到兔头 → 未命中 → 用兜底坐标，动画照常（实测见 §3.7）。

---

## 2. 参数怎么调（全部集中，改完重启/热更生效）

| 想改什么 | 改哪里 |
|---|---|
| 总开关（一键关动画=逃生门） | `electron/fx/config.ts` → `ENABLED: false`（隐藏/显示退化为瞬时 show/hide；**改主进程需重启 dev**） |
| 球窗大小 | `electron/fx/config.ts` → `ballWindowSize`（360；上限 ~400） |
| 托盘锚点**兜底值**（自动定位失败时用） | `electron/fx/config.ts` → `TRAY_ANCHOR` 默认 {1334,1071}，或环境变量 `PET_TRAY_ANCHOR="x,y"`（启动前设置） |
| 锚点自动定位参数（阈值/搜索带/候选数） | `electron/fx/anchor.ts` → `TEMPLATE_MIN_SCORE`(0.75) / `DOCK_BAND_PX`(90) / `CANDIDATE_TOPN`(6) / `TEMPLATE_SIZE`(24) |
| 锚点模板（换图标后重裁） | `resources/tray-anchor-template.png`（24×24，中心=图标中心；裁制方法见 §1.8） |
| 各段时长（飞行/捕获/回程/淡出/释放） | `electron/fx/config.ts` → `flightMs / captureMs / returnMs / fadeMs / releaseMs` |
| 拱线弧度 | `electron/fx/config.ts` → `arcFactor / arcMin / arcMax / arcTopMargin` |
| 缩到多小 | `electron/fx/config.ts` → `shrinkScale`（0.2） |
| 球颜色/光晕/尾迹/星屑/爆散参数 | `src/fx/config.ts`（FX_VISUAL；颜色池、粒子数、寿命、半径、shadowBlur…；**渲染侧改完 HMR 自动生效**） |
| 被抓/被放反应曲线 | `src/modules/pet/renderers/glb-model/pose.ts`（capturedReactionPose / releasedReactionPose）与 `part-animation/animator.ts` 对应段 |

---

## 3. 真机验证（证据）

> 日志：`/tmp/pet-dev.log`（关键行 ⬇）；截图序列：`/tmp/fx-shots/`（x11grab 30fps 全屏 PNG）

### 3.1 隐藏全链路（3 次，走 close 拦截路径 = Alt+F4 的 WM 消息语义）

```
[main] 关闭窗口 → 躲进托盘（退出请用托盘菜单）
[fx] 球窗已创建（360x360，全穿透）
[fx] t=0ms 隐藏动画开始：宠物 760,592 400x400，锚点 1864,984
[fx] t=794ms 球到达宠物（flight 780ms）
[renderer] [pet] fx reaction -> captured
[fx] t=1225ms 捕获完成（宠物缩至 0.2×，920,752 80x80）
[fx] t=1851ms 到达托盘锚点（return 620ms）
[fx] t=2052ms 隐藏动画完成
→ 窗口 Map State: IsUnMapped ✓（结果=隐藏）
```
三次样本：794/1229/1861/2065ms、794/1215/1846/2046ms、796/1229/1861/2068ms（抖动 <25ms）+ 复测 2067ms。

时序截图（`/tmp/fx-shots/hide-a/` 96 帧 + `hide-b/` 84 帧）：
- `crop-025.png`：球带拖尾星屑从托盘飞向宠物（方向正确）；
- `crop-040.png`：球抵达宠物身上；
- `crop-046.png`：捕获段——宠物正在缩小、爆散光效在它身上；
- `ball-060.png`：回程——球内小兔剪影 + 星屑，球下方可见缩小态的宠物；
- `anch-072.png`：球抵达 DDE 托盘区。

### 3.2 显示全链路（3 次，走托盘菜单"显示宠物"，DBusMenu 真实路径）

```
[tray] 显示宠物窗口（魔法球动画）
[fx] t=0ms 显示动画开始：原位 760,592 400x400，锚点 1864,984
[fx] t=790ms 球到达原位（flight 780ms）
[renderer] [pet] fx reaction -> released
[fx] t=1225ms 放大归位完成（760,592 400x400）
[fx] t=1426ms 显示动画完成
→ 窗口 IsViewable，位置 760,592 ✓（精确恢复原位；另一次从 1495,187 精确恢复）
```
截图（`/tmp/fx-shots/show-a/` 90 帧）：`show-026.png`（球载剪影飞行）、`show-034.png`（抵达原位）、`show-040.png`（释放+放大中）。

### 3.3 锁（动画中重复触发）

第二次触发日志：`[fx] 动画进行中，忽略本次隐藏请求`，动画照常走完 ✓。

### 3.4 动画中自主行为被中断

捕获瞬间恰有 look_around 执行中：`行为 look_around（b_5b845976）结束：interrupted=true`（后端也记录 interrupted=True）✓。

### 3.5 球窗全穿透

动画中把光标移到球窗覆盖区域（球窗中心 1231,761、覆盖 1051..1411/581..941，取点 1200,700）：
`xdotool getmouselocation` 返回的窗口是**球窗下方的终端窗口**（非球窗）→ 球窗不吃鼠标事件 ✓。

### 3.6 回归

- **拖拽**：960,730 → 1100,640 拖动，窗口 760,592 → 900,502，**0 误差**（drag start/end 日志正常）；
- **全局快捷键**：Ctrl+Shift+F9 → `clickThrough -> false/true` 日志正常；
- **退出链路**：托盘"退出" → `[main] 应用退出：清理后端子进程…` → 后端 SIGTERM 退出 → 进程 0 残留；
  **全程无任何 [fx] 日志**（退出不播动画）✓；
- **动画结束无残留**：球窗（0xb000006）Map State = IsUnMapped ✓（收窗正常）；
- **typecheck**：`npm run typecheck` 通过。

### 3.7 锚点自动定位

- **离线单测**（`PET_ANCHOR_SELFTEST=/tmp/screen-tray-now.png`，对实测截图跑匹配）：
  ```
  [fx/自检] 候选 (1334,1068) ncc=1.000 颜色=1.000 综合=1.000   ← 正确命中（±10px 要求内）
  [fx/自检] 候选 (696,1067)  ncc=0.776 颜色=0.817 综合=0.634   ← Deepin 浏览器图标误配（被阈值 0.75 排除）
  [fx/自检] 候选 (307,1068)  ncc=0.741 颜色=0.848 综合=0.628
  [fx/自检] … → 命中 (1334,1068) 综合置信 1.000（耗时 61ms）
  ```
- **真机**（动画内定位，desktopCapturer 路径）：`[fx] 锚点定位：自动命中 (1334,1068) 置信 1.000（耗时 129ms / 196ms / 154ms）`；
  隐藏与显示动画各跑通一轮，球起点/终点 = 兔头图标位置；
- **负向验证**（故意把兜底值改错）：`PET_TRAY_ANCHOR="1534,1271"` 启动后触发隐藏——
  日志仍为 `自动命中 (1334,1068)`（**未使用错值兜底**），录屏帧 `anchor-020.png` 显示球确实从真实兔头起飞；
- **证据帧**（`/tmp/fx-shots/`）：
  - `hide-anchor/anchor-020.png`：球**从兔头图标处腾起**（隐藏段起点）；
  - `hide-anchor/anchor-068.png`：球载着宠物剪影**回收进兔头图标**（隐藏段回程终点）；
  - `show-anchor/showanchor-016.png`：球载宠**从兔头腾起**（显示段起点）；
  - 序列全帧：`/tmp/fx-shots/hide-anchor/`（84 帧）、`/tmp/fx-shots/show-anchor/`（72 帧）。
- **跨屏实测（用户实操场景）**：用户把宠物拖到**副屏** (3264,393) 后用托盘菜单隐藏——
  球从主屏托盘锚点 (1334,1071) **跨屏飞行** 2000+px 到副屏宠物处，捕获/回程/收窗全部正常完成（2046ms）；
  球窗方案天然支持跨屏（窗口"飞到哪就是哪"，无全屏方案的覆盖范围限制）。
- **遮挡兜底实测（用户实操场景）**：用户全屏使用其它窗口时（主屏 Dock 不可见于抓屏图）——
  定位日志 `模板未命中，用兜底 (1334,1071)（耗时 138ms）`，动画照常完整播放（结果语义不受影响）。

---

## 4. 待用户确认清单（肉眼观感）

1. **球的样子**：青白光球（白→青渐变，照参考）+ 外圈紫色柔晕；载宠时球内半透明小兔剪影 + 轻微摇摆。
   如想更"紫"或更"亮"，改 `src/fx/config.ts` 的 FX_VISUAL（HP 可实时热更）。
2. **时长节奏**：隐藏 ≈2.05s（780+420+620+180）、显示 ≈1.42s（780+420+180），按参考的 780+420 节奏。
   觉得拖沓/太快 → 改 `electron/fx/config.ts` 时长项。
3. **"抓走"观感**：当前捕获段宠物**原地缩小**（被球吸住），"拎着飞回托盘"由**回程段**（球+缩小宠物同步沿拱线飞）表现
   （原任务书曾写"边缩边移向托盘"，那样宠物先到托盘、回程就没有飞行空间了，故拆开）。若坚持边缩边移 → 可加回。
4. **托盘锚点**：**自动定位**（每次动画前抓屏匹配兔头图标，实测命中 (1334,1068)，置信 1.000）——
   球从兔头图标处腾起/收回；自动定位失败时用兜底值（1334,1071，可 `PET_TRAY_ANCHOR="x,y"` 覆盖）。
   移动/增删托盘图标后无需改代码（下次动画自动重新定位）。
5. **球窗大小** 360×360（视觉半径收敛在窗内）；可按需放大到 ≤400。
6. **托盘图标单击（显示）路径**：DDE 下自动化工具够不到该图标（详见 §5 坑 3），请手点一次确认；
   菜单"显示宠物"路径已自动化验证通过（两者同一处理器）。

---

## 5. 坑与遗留

1. **全屏透明层 → 球窗（用户修正）**：全屏方案会覆盖用户操作，弃用；球窗方案天然解决多屏问题
   （球窗"飞到哪就是哪"，无需覆盖特定显示器）。
2. **DDE 下宠物窗口（type:'toolbar'）无法被 WM 激活**：`xdotool windowactivate` 无效、
   点击不设 _NET_ACTIVE_WINDOW、`xdotool windowclose` 不触发 close —— ALT+F4 无法用 xdotool 命中。
   **验证 close 路径的正确姿势**：用 X11 客户端消息发 `WM_DELETE_WINDOW`（本次写了小工具 `/tmp/fx-tools/send-close.c`）。
   **注意**：不要用 `xdotool windowclose`（实测把 GPU 进程搞崩了：`GPU process exited code=11` + WebGL 上下文丢失，需重启应用恢复；
   本改动无关，纯测试工具副作用）。
3. **dbus-send 调 DBusMenu 必须带 `--print-reply`**：不带时 libdbusmenu 的 `Event` 静默不生效（实测多次复现）。
   模拟托盘菜单点击的命令：
   ```bash
   SNI=:1.xxxxx   # 从 StatusNotifierWatcher 的 RegisteredStatusNotifierItems 里按 pid 找
   dbus-send --session --print-reply --dest=$SNI /com/canonical/dbusmenu \
     com.canonical.dbusmenu.GetLayout int32:0 int32:2 array:string:   # 找菜单项 id
   dbus-send --session --print-reply --dest=$SNI /com/canonical/dbusmenu \
     com.canonical.dbusmenu.Event int32:<id> string:"clicked" variant:string:"" uint32:0
   ```
4. **隐藏期间后端行为引擎仍会移动（隐藏的）宠物窗**（walk 等，既有行为，非本改动引入）：
   因 stash 在隐藏时记录，**显示归位不受影响**；但若 walk 恰在动画中并发会与 fx 抢 `setBounds`
   → 已用"捕获时中断当前行为"缓解（见 §1.6）；"隐藏期间新下发的行为"仍会移动隐藏窗口（无视觉影响，未处理）。
5. **球窗尾迹/爆散受窗口边界裁剪**：已在视觉设计里收敛（尾迹 ≤8 点/150px、爆散半径 ≤88px）；
   若把 `ballWindowSize` 调小，需同步检查 `src/fx/config.ts` 的半径参数。
6. **主进程改动必须重启 dev**（既定流程）；渲染侧（src/fx、PetView）改动 HMR 自动生效。
7. **锚点自动定位的两个坑**（都已处理，备忘）：
   - **纯灰度 NCC 会误配**：Dock 上"白/蓝圆的浏览器图标"与白兔头灰度结构相似（NCC 0.78）——
     必须叠加 RGB 颜色校验（综合分 = NCC × 颜色分，实测把误配压到 0.63、真实兔头 1.00）；
   - **`PET_ANCHOR_SELFTEST` 自检跑在托盘注册之前**（whenReady 时即执行）：启动瞬间抓屏里还没有兔头
     图标，会"未命中/兜底"——属预期；真实动画路径中托盘必然已注册（应用已运行），不受影响。
   另：**托盘图标外观更新后主模板会失配**（自动降级到备用模板/兜底值，动画照常）——按 §1.8 方法重裁模板。
8. **遗留**：托盘单击的自动化验证（§4.6）；`ENABLED=false` 逃生门未做真机回归（一行直通路径，风险低）；
   锚点定位精度实测偏移 ≤3px（模板含均匀背景边缘时 NCC 可沿该方向滑动数像素，无视觉影响）。
