> ⚠️ 历史快照（2026-10-14，**部分过期**）：穿透主机制已改为「空气让路」（见 electron/window/hit-gate.ts + xdotool 光标源），文中穿透方案部分作废；①forward 不转发 mousemove ②光标坐标冻结 ③setShape([]) 陷阱等实测结论**仍有效**（气泡窗仍在用 setShape）。索引见 docs/报告/README.md。

# 前端窗口能力验证报告（P1 步骤 1+2）

> 环境：Deepin Linux / X11（DISPLAY=:0，双屏 1920x1080 + HDMI-1 1920x1080+1920+0）
> Node v22.23.1 / npm 10.9.8 / Electron 33.4.11 / electron-vite 2.3
> 日期：2026-10-14

---

## ① 需要用户肉眼确认的清单（预计 1 分钟）

> 应用**此刻正在后台运行**：窗口 400x400，初始位于主屏（1920x1080）底部居中 (760,592)；
> 如已被拖动，以实际位置为准（可在桌面任意处寻找黑白企鹅）。
> 日志：`/tmp/pet-dev.log`

- [ ] **1. 透明 + 无边框（10s）**：🐧 周围应**完全透出桌面**——无白/灰方块背景、无标题栏、无阴影。
      再把鼠标移到企鹅**周围的空白区**点击桌面图标——应能正常点中（说明该区域已放行给桌面）。
      ⚠ 例外：底部黑底状态栏属于可交互区，点击它不会穿透（见已知限制 3）。
      ⚠ 视觉说明：本机无彩色 emoji 字体，🐧 是黑白轮廓（Symbola 字体），属预期。
- [ ] **2. 置顶（10s）**：打开任意窗口（如文件管理器）拖到宠物上方，宠物应始终浮在最上层。
- [ ] **3. 拖拽跟手（20s）**：鼠标移到企鹅上按住左键，快速画圈/甩动——窗口应平滑跟手、松手即停，
      快速甩动**不应脱手**（自动化已过 7 组 0 误差，但"手感/流畅度"需你确认）。
- [ ] **4. 穿透切换反馈（10s）**：按 `Ctrl+Shift+F9` 切换穿透、`Ctrl+Shift+F10` 切换置顶、
      `Ctrl+Shift+F11` 显示/隐藏 hitbox 绿色虚线框（应正好圈住企鹅）；
      每次按键后底部状态栏文字应同步变化。验收完请按 F9 恢复"穿透：开"。
- [ ] **5. 任务栏（5s）**：Deepin Dock 上**不应**出现"AI 桌面宠物"图标（若出现见已知限制 1）。
- [ ] **6. 呼吸动画（5s）**：企鹅缓慢一缩一放（2.6s 周期）。

---

## ② 各项能力：实现方式与自动化验证结果

### 透明窗口
- 实现：`transparent:true + frame:false + hasShadow:false + backgroundColor:'#00000000'`；渲染层 `html/body/#root` 背景 transparent。
- 自动验证：`xwininfo -id <win>` → `Depth: 32 / Visual Class: TrueColor`（ARGB 视觉，支持逐像素透明）✅
- 肉眼项：清单 1。

### 置顶
- 实现：`alwaysOnTop:true`（统一接口 `setAlwaysOnTop`）。
- 自动验证：`xprop` → `_NET_WM_STATE = _NET_WM_STATE_ABOVE, _NET_WM_STATE_STAYS_ON_TOP`；跨屏拖拽后复检仍置顶 ✅

### 点击穿透（本次技术核心，**方案有变更**）
- **原定方案（任务书）**：默认 `setIgnoreMouseEvents(true,{forward:true})` + 渲染 mousemove 检测 hitbox + 主进程轮询兜底。
- **实测发现两个 X11 障碍**（详见 ④ 坑 1、2）：
  1. `forward:true` 在 X11 下**不转发** mousemove——穿透态下渲染进程收不到任何鼠标事件，悬停检测无法闭环；
  2. `screen.getCursorScreenPoint()` 是**事件驱动缓存**——光标离开窗口交互区后返回值冻结，轮询兜底不可行。
- **最终实现**：改用 **X11 窗口形状 `BrowserWindow.setShape()`**：
  - 输入形状 = 宠物 hitbox 矩形 (70,70,260,260) + 状态栏矩形 (24,341,352,49)（渲染侧经 IPC 上报）；
  - 形状外 → 系统级放行给桌面（真穿透）；形状内 → 窗口接管鼠标；
  - 渲染侧 hover 逻辑保留（进入 hitbox → `setClickThrough(false)` 全窗接管；离开 → 恢复形状），
    作为动态层保留，同时也是 Windows 平台的统一逻辑；
  - 陷阱：`setShape([])` 会让输入区变空（窗口彻底收不到事件），"恢复全窗"必须显式给全窗矩形。
- 自动验证（xdotool 移动光标 + 日志核对）：
  - 窗口内形状外 (790,622)：无任何事件 ✅（穿透保持）
  - hitbox 内 (960,792)：`hitbox enter` → `clickThrough -> false` ✅
  - 窗口内 hitbox 外 (960,950)：`hitbox leave` → `clickThrough -> true` ✅
  - 形状外窗口另一角 (960,950 属下方空白) 同样不拦截 ✅
- 肉眼项：清单 1、4（"点桌面能点中"是穿透的最终判据）。

### 拖拽（自绘，透明窗口下禁用 -webkit-app-region）
- 实现：渲染侧 `pointerdown`（`setPointerCapture`）→ 起始屏幕坐标经 IPC 给主进程 → `pointermove`（rAF 节流）
  持续上报坐标 → 主进程 `setBounds` 跟随 → `pointerup` 对齐落点并结束。X11 下 pointer capture 由指针 grab 保证
  **光标滑出窗口后事件仍连续送达**，因此不用主进程定时器轮询（该 API 已证实不可靠，见坑 2）。
- 自动验证（xdotool 模拟真实鼠标操作，`xwininfo` 核对窗口坐标）：

| 场景 | 期望 | 实际 | 结果 |
|---|---|---|---|
| 瞬跳拖拽 (+220,+140) | (980,732) | (980,732) | ✅ 0 误差 |
| 分步移动 (-260,-140) | (720,592) | (720,592) | ✅ 0 误差 |
| 回程 (+150,+140) | (870,732) | (870,732) | ✅ 0 误差 |
| 跨屏拖拽 (+1920,-248) | (2680,344) | (2680,344) | ✅ 0 误差 |

- 肉眼项：清单 3（手感与流畅度）。

### 调试快捷键（全局，主进程 globalShortcut）
- `Ctrl+Shift+F9` 穿透开/关；`Ctrl+Shift+F10` 置顶开/关；`Ctrl+Shift+F11` hitbox 边框显示/隐藏。
- 自动验证：xdotool 合成按键 → 主进程日志依次出现
  `hitbox 边框 -> 显示/隐藏`、`alwaysOnTop -> false/true`、`clickThrough -> true/false`，且状态同步推送到渲染侧 ✅

### 窗口基础
- 400x400、无边框、`skipTaskbar:true`、`resizable:false`、初始位置底部居中 (760,592) ✅（xwininfo 核验）

---

## ③ 启动 / 关闭命令

```bash
# 启动（开发态，当前正在后台运行）
cd /home/yicaibao/my/Ai-desktop-pet/frontend
npm run dev                    # 前台；本次验证用的是 npm run dev > /tmp/pet-dev.log 2>&1 &

# 关闭
pkill -x electron              # 或在运行终端 Ctrl+C

# 其它
npm run typecheck              # 类型检查（已通过）
npm run build && npm run preview   # 生产构建与预览
```
- 开发服务端口：5173 起自动选择（本次运行在 5175，被占用会自动顺延，不影响使用）。

---

## ④ 坑与解决（按发现顺序）

1. **Linux forward 不转发鼠标事件**：`setIgnoreMouseEvents(true,{forward:true})` 后，穿透态下渲染进程收不到
   `mousemove`（实测：光标移入窗口后无任何渲染日志）→ Electron 文档对 forward 的实现保证主要在 macOS/Windows。
   **解决**：改用 X11 窗口形状（`setShape`）承担穿透，见 ② 。
2. **`screen.getCursorScreenPoint()` 冻结**：在 X11 上它是事件驱动缓存——光标离开窗口交互区后返回值不再更新
   （实测：连续 10s 返回同一旧坐标）。这直接导致"主进程定时器轮询兜底"和"定时器拖拽跟随"失效
   （曾复现拖拽时窗口 1 秒只走了 2px 的"卡死"）。
   **解决**：放弃该 API；拖拽改为渲染侧 pointermove 事件驱动。
3. **`setShape([])` 陷阱**：清空形状会让窗口输入区为空（窗口彻底收不到事件，且不像"恢复默认"）。
   **解决**：显式传全窗矩形 `[{0,0,400,400}]`。
4. **拖拽用主进程定时器方案不可行**（与坑 2 同源）：曾出现"快速甩动窗口脱手"。
   **解决**：pointer capture + rAF 节流事件流（现 7 组测试 0 误差）。
5. **SUID sandbox**：本机 unprivileged user namespaces 可用，**未报 SUID sandbox 错误**，
   无需 `--no-sandbox`（也未配置）。
6. **libva 警告**：启动日志有 `libva error: iHD_drv_video.so / i965_drv_video.so init failed`——
   是 Intel 视频加速驱动未装/不兼容，不影响渲染（软件渲染兜底），仅日志噪音。
7. **Electron 二进制下载**：`~/.cache/electron/electron-v33.4.11-linux-x64.zip` 已有缓存，
   安装零下载（package.json 固定 `electron@33.4.11` 以命中缓存）；npm 官方源可用（依赖安装约 2 分钟）。
8. **CSP 安全警告**（dev 态）：console 提示 Insecure Content-Security-Policy，打包态不显示；
   生产构建前需补 CSP（dev 态 HMR 需要内联脚本，暂不加）。

---

## ⑤ 已知限制

1. **skipTaskbar 未获 X11 属性佐证**：`_NET_WM_STATE` 中未见 `SKIP_TASKBAR`（Electron 33 在 X11 上的实现细节 +
   Deepin WM 行为未知）。请肉眼确认 Dock 是否有图标；若出现，后续改用窗口 type（toolbar/dock）解决。
2. **形状裁剪渲染边界**：`setShape` 同时裁剪可见区域，宠物 emoji 的 drop-shadow 若溢出形状边界会被裁掉
   （当前形状 260x260 基本包住，视觉影响轻微；Live2D 接入后需按模型实际尺寸调整形状）。
3. **状态栏属可交互区**：状态栏矩形被纳入输入形状（否则不可见），所以点击它不会穿透桌面。
   如需要"状态栏可见但不可点击"，需把渲染拆成两层形状策略（Electron setShape 单次形状无法只裁 input 不裁渲染）。
4. **无拖拽看门狗**：若渲染进程在拖拽中崩溃，窗口会停留在"全窗接管"状态（不崩溃则不会发生）。P1 后续可加超时保护。
5. **Wayland 降级未实测**：linux.ts 内置 Wayland 检测（降级为不透明窗口 + 建议 `--ozone-platform=x11`），
   本机为 X11，降级分支行为未经验证。
6. **Windows / macOS 实现未验证**：`win32.ts` 按统一接口实现（注释了 Windows 平台差异，未在真机回归）；
   `darwin.ts` 为降级兜底（不透明、无穿透）。平台差异全部收敛在 `electron/window/` 内，新增平台=加一个文件+注册一行。
7. **副屏缩放因子差异**：本机双屏若 DPI 缩放不同，跨屏拖拽的坐标换算未经极端场景验证（本次双屏同为 1920x1080 通过）。
