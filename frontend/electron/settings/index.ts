/**
 * 设置窗口域（P4 前置，设计文档 §7.6）——独立设置窗口的生命周期 + 应用级 IPC + 向导编排。
 *
 * 职责边界（高内聚：与设置窗口有关的一切都在本目录）：
 *  - 窗口生命周期：单例（已打开 → 聚焦；关闭即清引用，下次打开重建）、约 760×560 居中、
 *    **系统标题栏常规窗口**（frame:true、可拖动/最小化、任务栏可见）——设置是工具型界面，
 *    用户预期是正常窗口；刻意**不**照抄宠物窗/黑板窗的「无边框 + 透明 + 置顶 + skipTaskbar +
 *    Linux type:'toolbar'」悬浮窗技术（那是给「不该出现在任务栏的桌宠层」用的）；
 *  - 向导编排（§7.6.6）：设置窗打开 → 记宠物原位 + 广播 SETTINGS_VISIBILITY{opened} +
 *    ball-animation 域 relocate 宠物到"扒窗沿"向导位（几何纯函数见 settings/geometry.ts）；
 *    **保存不回位**（SETTINGS_SAVED 只记日志——宠物留在向导位候命，2026-10-16 用户定稿）；
 *    **关闭设置窗**（closed 链）→ 反向 relocate 回原位 + 广播 closed。
 *    状态机（wizardActive / returning）防重入：已回位不重复回位；
 *  - 页面加载：settings.html（dev 走 ELECTRON_RENDERER_URL 同目录换名、生产 out/renderer/settings.html，
 *    与 teaching 的 board.html 同法）；
 *  - IPC 契约（channels.ts 已写死）：
 *      IPC.SETTINGS_OPEN   —— 托盘菜单 / 聊天关键词共用入口 → openSettings()（单例收敛）；
 *      IPC.SETTINGS_SAVED  —— 设置面保存成功上报 → 宠物留在向导位（关闭窗口才回位）；
 *      IPC.APP_RESTART     —— 设置页「重启」→ restartApp()：先停后端（防孤儿进程）再 relaunch。
 *
 * 数据流（§7.6.2）：设置页**自持 WS 连接**（经 backend.getSnapshot() 取 port/token 自行连接），
 * 本域不参与设置项读写——只管「窗口怎么开、怎么关、向导怎么编排、重启怎么做」。
 * 飞位动画一律经 ball-animation 域 runRelocateAnimation（本域不碰球窗/时序，只给目标坐标）。
 */
import { app, BrowserWindow, ipcMain, screen, shell, type WebContents } from 'electron'
import { join } from 'node:path'
import { isLinux } from '../platform'
import { IPC, IPC_EVENTS, type SettingsVisibilityPhase } from '../ipc/channels'
import { resolveAppIconImage } from '../app-icon'
import { backendManager } from '../backend-process'
import { runRelocateAnimation } from '../ball-animation'
import { petMouthY, wizardPetRect } from './geometry'
import { getTeachingMode } from '../teaching'
import { probeXWindowAlive, type XWindowAlive } from './window-health'
import { petWindowSize } from '../window'
import { getPetScale } from '../pet-scale'
import { isAppQuitting } from '../lifecycle'
import type { Rect, Size } from '../window'

const isDev = !app.isPackaged

/** 设置窗口尺寸（逻辑像素；§7.6.1；2026-10-18 用户定：默认约 760×560，内容区更宽） */
const SETTINGS_WINDOW_WIDTH = 760
const SETTINGS_WINDOW_HEIGHT = 560
/** 窗口标题（主进程为权威：page-title-updated 被拦截，防渲染页 <title> 覆盖契约文案） */
const SETTINGS_WINDOW_TITLE = '设置 · AI 桌面宠物'

// ------------------------------------------------------------------ 模块级状态（本域单例）

/** 当前设置窗口（单例；关闭/加载失败后置 null，下次打开重建） */
let settingsWin: BrowserWindow | null = null
/** ipcMain 监听是否已注册（只能注册一次，重复注册会叠加处理器） */
let ipcRegistered = false
/** 重启流程进行中标志（防「重启」按钮连点触发两次 stop + relaunch） */
let restarting = false

/** 宠物窗口（initSettings 注入；向导广播与 relocate 的对象） */
let petWin: BrowserWindow | null = null
/**
 * 向导状态机：true = 向导流程已启动（宠物已被迁往向导位/正在位）——saved/closed 时它是
 * "需要回位"的唯一依据；回位开始即复位（已回位不重复回位）。置位发生在 relocate 之前
 * （relocate 飞行途中关窗也能正确回位）。
 */
let wizardActive = false
/** 向导 relocate 前记录的宠物原位（回位目标；随 wizardActive 生命周期） */
let petHomeRect: Rect | null = null
/** 回位 relocate 进行中（防 saved + closed 连续触发两次回位） */
let returning = false

/**
 * 健康巡检间隔（ms）：低频（一次 xwininfo 子进程调用 ≈ 数 ms）。
 * 可用环境变量 PET_SETTINGS_HEALTH_MS 覆盖（≥100；dev/排障/自动化实测用，先例 PET_TRAY_ANCHOR）。
 */
const HEALTH_CHECK_MS = (() => {
  const raw = Number(process.env['PET_SETTINGS_HEALTH_MS'])
  return Number.isFinite(raw) && raw >= 100 ? raw : 10000
})()
/** 健康巡检定时器（设置窗生命周期内运行；非 Linux 从不启动） */
let healthTimer: NodeJS.Timeout | null = null
/** 巡检探测在途标志（防重入：一次探测未回来前不发新的） */
let healthProbing = false
/** openSettings 健康校验在途标志（防用户狂点并发触发重复建窗） */
let openingCheck = false

// ------------------------------------------------------------------ 窗口生命周期

/**
 * 创建设置窗口（常规窗口技术，见文件头；窗口本身不在创建时显示——
 * ready-to-show 后 show，防白屏闪烁，同宠物窗）。
 */
function createSettingsWindow(): BrowserWindow {
  const win = new BrowserWindow({
    // 任务栏/标题栏图标：与托盘、通知共用兔子图标（2026-10-21）
    icon: resolveAppIconImage(),
    width: SETTINGS_WINDOW_WIDTH,
    height: SETTINGS_WINDOW_HEIGHT,
    title: SETTINGS_WINDOW_TITLE,
    // 系统标题栏常规窗口：frame:true（默认）显式写出，强调与宠物/黑板的刻意不同；
    // 不设 alwaysOnTop / skipTaskbar / type:'toolbar'——任务栏可见、可最小化、可拖动
    frame: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // 标题权威在主进程：渲染页对 document.title 的更新一律丢弃（契约固定「设置 · AI 桌面宠物」）
  win.on('page-title-updated', (event) => event.preventDefault())

  // 常规窗口默认会显示 Electron 应用菜单栏（File/Edit/View…）——工具型设置页不需要，去掉
  win.setMenu(null)

  // 外链走系统浏览器（设置页「去获取 Key」等 http(s) 链接）；其余新窗口一律拒绝
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // dev 态：渲染进程 console 转发到主进程 stdout（无 devtools 环境排障；同宠物窗/黑板窗）
  if (isDev) {
    win.webContents.on('console-message', (_event, _level, message) => {
      console.log(`[settings-renderer] ${message}`)
    })
  }

  win.once('ready-to-show', () => {
    win.show()
    console.log('[settings] 设置窗口已显示')
    // 显示后立即走向导编排（§7.6.6）：广播 opened + 宠物 relocate 到"扒窗沿"向导位。
    // 窗口已 center() 定位、getBounds 稳定；异步进行（设置页加载/交互不等待动画）
    void beginWizard()
  })

  win.on('closed', () => {
    stopHealthWatch()
    if (settingsWin === win) {
      settingsWin = null
      console.log('[settings] 设置窗口已关闭（引用已清理，下次打开重建）')
    }
    // 宠物在向导位 → 反向 relocate 回原位 + 广播 closed（"已回位则不重复"由状态机保证）。
    // 用户关闭、加载失败/渲染崩溃的兜底销毁、健康巡检清理统一走这里；退出链路
    // （destroySettings 预置 wizardActive=false）自然 no-op，不做回位/广播
    void returnPetHome()
  })

  // 加载失败/渲染崩溃兜底：关闭窗口并清引用（单例不卡在坏窗口上，用户下次点击即重建重试）。
  // 只看「当前受管窗口」（settingsWin === win）：旧窗口迟来事件不再处理（同 teaching 受管窗口约定）
  win.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || settingsWin !== win) return
      console.error(
        `[settings] 设置页加载失败（${errorCode} ${errorDescription} ${validatedURL}），关闭窗口以便重试`
      )
      settingsWin = null
      if (!win.isDestroyed()) win.destroy()
    }
  )

  win.webContents.on('render-process-gone', (_event, details) => {
    if (settingsWin !== win) return
    console.error(`[settings] 设置页渲染进程崩溃（${details.reason}），关闭窗口以便重试`)
    settingsWin = null
    if (!win.isDestroyed()) win.destroy()
  })

  loadSettingsPage(win)
  // 居中打开（主显示器工作区中央；§7.6.1）
  win.center()
  // 启动健康巡检（Linux）：外部强杀（X 层窗口消失）在 Electron 事件层不可见，
  // 低频探测保证"引用与窗口状态最终一致"（见 window-health.ts 与 startHealthWatch）
  startHealthWatch(win)
  console.log(
    `[settings] 设置窗口已创建（${SETTINGS_WINDOW_WIDTH}x${SETTINGS_WINDOW_HEIGHT} 居中；${win.getBounds().x},${win.getBounds().y}）`
  )
  return win
}

/**
 * 加载设置页：dev 走 electron-vite 渲染服务器（ELECTRON_RENDERER_URL，文件名换成 settings.html）；
 * 生产走打包产物 out/renderer/settings.html。settings.html 由渲染侧提供，本域只管路径约定。
 */
function loadSettingsPage(win: BrowserWindow): void {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (isDev && devUrl) {
    // 用 URL 相对解析：base 无论是否带尾斜杠/是否带 index.html，都能得到同目录的 settings.html
    // （与 teaching/board.html 同法）
    try {
      void win.loadURL(new URL('settings.html', devUrl).toString())
      return
    } catch (err) {
      console.warn(`[settings] ELECTRON_RENDERER_URL 非法（${devUrl}），回退 loadFile：`, err)
    }
  }
  void win.loadFile(join(__dirname, '../renderer/settings.html'))
}

/**
 * 打开设置窗口（唯一公共入口：托盘菜单 / SETTINGS_OPEN IPC 都走这里；异步实现、同步签名）。
 * 单例：已打开则聚焦（最小化先还原），不重复创建——也就不重复走向导（宠物已在向导位）。
 * **健康校验**（防"僵尸引用"，见 window-health.ts）：已存在分支先探测 X 层窗口是否仍在——
 * 死窗（外部强杀，Electron 事件层不可见）清理引用并重建，**绝不聚焦死窗**；
 * 不可检测（非 Linux/Wayland/命令缺失）时保持既有聚焦行为（不误判）。
 */
export function openSettings(): void {
  void openSettingsChecked()
}

/** openSettings 的异步实现：健康校验 → 聚焦 / 清理重建（并发请求由 openingCheck 收敛） */
async function openSettingsChecked(): Promise<void> {
  const existing = settingsWin
  if (existing && !existing.isDestroyed()) {
    if (openingCheck) return // 校验在途：忽略重复请求（首个请求很快完成并显示窗口）
    openingCheck = true
    let alive: XWindowAlive
    try {
      alive = await probeXWindowAlive(existing)
    } finally {
      openingCheck = false
    }
    if (alive === false) {
      console.warn('[settings] 打开设置：检测到僵尸设置窗（X 层窗口已消失）→ 清理引用并重建')
      if (settingsWin === existing) {
        settingsWin = null
        stopHealthWatch()
        // destroy 触发 closed handler → returnPetHome()（宠物若还在向导位则回位 + 广播）
        if (!existing.isDestroyed()) existing.destroy()
      }
    } else {
      // 活窗（或不可检测）：走既有聚焦路径
      if (existing.isMinimized()) existing.restore()
      // show() 对已可见窗口仍是「显示并聚焦」，兼顾「存在但被隐藏」的极端态
      existing.show()
      existing.focus()
      console.log('[settings] 设置窗口已存在 → 聚焦（不重复创建/不重排向导）')
      return
    }
  }
  // 新建路径（无窗口 / 死窗已清理；若并发路径刚建出窗口则聚焦它）
  const current = settingsWin
  if (current && !current.isDestroyed()) {
    current.show()
    current.focus()
    return
  }
  settingsWin = createSettingsWindow()
}

/** 应用退出清理（will-quit；窗口随退出直接销毁，不做额外等待） */
export function destroySettings(): void {
  // 退出链路：向导状态直接丢弃（不回位/不广播——宠物窗也随退出销毁）
  wizardActive = false
  petHomeRect = null
  returning = false
  petWin = null
  stopHealthWatch()
  const win = settingsWin
  settingsWin = null
  if (win && !win.isDestroyed()) win.destroy()
}

// ------------------------------------------------------------------ 窗健康巡检（防 X 层僵尸引用）

/** 停止健康巡检（幂等；窗口关闭/销毁/退出时调用） */
function stopHealthWatch(): void {
  if (healthTimer) {
    clearInterval(healthTimer)
    healthTimer = null
  }
}

/**
 * 启动健康巡检：设置窗存在期间低频探测 X 层窗口是否存在。
 * 外部强杀（xdotool windowclose / WM 异常等）在 Electron 事件层与状态探针上完全不可见
 * （独立实验实测，见 window-health.ts）——巡检是"引用与窗口状态最终一致"的兜底：
 * 发现死窗 → 清引用 + destroy（closed 链 → 向导回位广播），下次打开即正常重建。
 * 非 Linux / 不可检测时探针恒为 null，本巡检无害空转（仅一次异步调用开销）。
 */
function startHealthWatch(win: BrowserWindow): void {
  if (!isLinux) return
  stopHealthWatch()
  console.log(`[settings] 健康巡检已启动（间隔 ${HEALTH_CHECK_MS}ms）`)
  healthTimer = setInterval(() => {
    void healthCheck(win)
  }, HEALTH_CHECK_MS)
}

/** 单次健康检查（防重入；窗口换任/已被正常关闭时自然退出） */
async function healthCheck(win: BrowserWindow): Promise<void> {
  if (healthProbing) return
  if (settingsWin !== win || win.isDestroyed()) {
    stopHealthWatch()
    return
  }
  healthProbing = true
  try {
    const alive = await probeXWindowAlive(win)
    if (alive !== false || settingsWin !== win) return
    console.warn(
      '[settings] 健康巡检：设置窗的 X 层窗口已消失（外部销毁）→ 按关闭处理（清理引用 + 回位广播）'
    )
    settingsWin = null
    stopHealthWatch()
    // destroy 触发 closed handler → returnPetHome()；已销毁的极端情形手动兜一次
    if (!win.isDestroyed()) win.destroy()
    else void returnPetHome()
  } finally {
    healthProbing = false
  }
}

// ------------------------------------------------------------------ 向导编排（§7.6.6）

/** 取宠物窗口（会话内有效；未注入/已销毁时返回 null） */
function getPetWindow(): BrowserWindow | null {
  if (!petWin || petWin.isDestroyed()) return null
  return petWin
}

/** 广播向导状态给宠物窗（载荷 SettingsVisibilityPayload；宠物面据此收面板/冒泡/恢复） */
function broadcastVisibility(phase: SettingsVisibilityPhase): void {
  const pet = getPetWindow()
  if (!pet || pet.webContents.isDestroyed()) {
    console.log(`[settings] 广播向导状态 ${phase}（宠物窗不可用，跳过）`)
    return
  }
  pet.webContents.send(IPC_EVENTS.SETTINGS_VISIBILITY, { phase })
  console.log(`[settings] 广播向导状态：phase=${phase}`)
}

const rectStr = (r: Rect): string => `${r.x},${r.y} ${r.width}x${r.height}`

/**
 * 开始向导（设置窗 ready-to-show 后调用）：
 * 记宠物原位 → 广播 opened（宠物面立即收面板 + 冒泡萌语）→ relocate 至"扒窗沿"向导位。
 * 防重入：wizardActive 已置位时忽略（重复打开设置走 openSettings 的聚焦分支，不会进这里）。
 * **教学模式中例外**（2026-10-16 用户定稿）：兔子留在讲台**不动**——跳过向导位编排，
 * 只广播 opened（关闭时同样不动，见 returnPetHome 的空原位路径）。
 */
async function beginWizard(): Promise<void> {
  const pet = getPetWindow()
  const sw = settingsWin
  if (!pet || !sw || sw.isDestroyed()) {
    console.log('[settings] 开始向导：宠物/设置窗不可用，跳过')
    return
  }
  if (wizardActive) {
    // 已有进行中的向导（如设置窗曾因渲染崩溃被兜底销毁后重开——宠物仍在向导位）：
    // 不重复 relocate，但重发 opened 广播（幂等：宠物面据此回向导 UI 态）
    console.log('[settings] 向导已在进行（宠物应在向导位），仅重发 opened 广播')
    broadcastVisibility('opened')
    return
  }

  // 教学模式中：**兔子不动**（用户定稿"处于教学模式时，打开设置时，兔子不要动"）——
  // 不记原位、不 relocate；petHomeRect 保持 null → 关闭时 returnPetHome 走"宠物窗/原位
  // 不可用，仅广播"路径，同样不动兔子。wizardActive/opened 广播照旧（教学态面板本已收起，无害）。
  if (getTeachingMode() === 'teaching') {
    wizardActive = true
    broadcastVisibility('opened')
    console.log('[settings] 教学模式中打开设置：跳过向导位编排（兔子留在讲台不动）')
    return
  }

  // 原位只取坐标；尺寸取当前缩放档位（getBounds 在 fractional DPI 下是舍入值，
  // 回喂 relocate 会让宠物窗每次开关设置长大 1px——见 window/index.ts PET_WINDOW_SIZE）
  const homeBounds = pet.getBounds()
  const petSize = petWindowSize(getPetScale())
  petHomeRect = {
    x: homeBounds.x,
    y: homeBounds.y,
    width: petSize.width,
    height: petSize.height
  }
  wizardActive = true
  broadcastVisibility('opened')

  const sBounds = sw.getBounds()
  const wa = screen.getDisplayMatching(sBounds).workArea
  const target = wizardPetRect(sBounds, petSize, wa, petMouthY(getPetScale()))
  console.log(
    `[settings] 向导入位：宠物 ${rectStr(petHomeRect)} → ${rectStr(target)}（设置窗 ${rectStr(sBounds)}）`
  )
  await runRelocateAnimation(pet, target)
}

/**
 * 回位（**关闭设置窗时**触发；保存不再触发——2026-10-16 用户定稿）：宠物在向导位时
 * 反向 relocate 回原位 + 广播 closed。
 *  - 已回位（wizardActive=false）→ no-op（"已回位则不重复"）；
 *  - 宠物隐藏中 → 直接 setBounds 回原位（不播动画：relocate 的释放段会把宠物"显示出来"，
 *    违背用户刚做的隐藏动作）；
 *  - 广播在回位完成后发（宠物面"面板恢复"与宠物落位同步；异常/放弃路径也保证广播）。
 */
async function returnPetHome(): Promise<void> {
  if (!wizardActive) return
  // 应用退出中（will-quit 销毁设置窗 → closed → 本函数）：不再启动回位动画/创建球窗，
  // 否则会把 Electron 的退出流程卡住（2026-10-22 用户实测）。只广播让渲染侧收尾。
  if (isAppQuitting()) {
    console.log('[settings] 应用退出中：跳过向导回位')
    wizardActive = false
    petHomeRect = null
    broadcastVisibility('closed')
    return
  }
  if (returning) {
    console.log('[settings] 回位进行中，忽略重复回位请求')
    return
  }
  const pet = getPetWindow()
  const home = petHomeRect
  wizardActive = false
  petHomeRect = null
  returning = true
  try {
    if (!pet || !home) {
      console.log('[settings] 回位：宠物窗/原位不可用，仅广播')
      return
    }
    if (!pet.isVisible()) {
      pet.setBounds(home)
      console.log(`[settings] 回位：宠物隐藏中 → 静默改坐标回 ${rectStr(home)}`)
      return
    }
    console.log(`[settings] 回位：relocate 回 ${rectStr(home)}`)
    await runRelocateAnimation(pet, home)
  } finally {
    returning = false
    broadcastVisibility('closed')
  }
}

/**
 * 宠物缩放档位变更（主进程 applyPetScale 调用；用户在设置里改大小时立即生效）。
 * - 原位矩形按**底部中心锚定**换算到新尺寸（关闭设置回位时脚底不跳）；
 * - 向导位按新尺寸/嘴线重算并 relocate（嘴仍压设置窗底边线）；
 * - 教学模式中兔子固定在讲台，不参与向导位重摆（与 beginWizard 的例外一致）。
 */
export async function onPetScaleChanged(oldSize: Size, newSize: Size, scale: number): Promise<void> {
  if (petHomeRect) {
    petHomeRect = {
      x: Math.round(petHomeRect.x + (petHomeRect.width - newSize.width) / 2),
      y: Math.round(petHomeRect.y + petHomeRect.height - newSize.height),
      width: newSize.width,
      height: newSize.height
    }
  }
  const pet = getPetWindow()
  const sw = settingsWin
  if (!wizardActive || !pet || pet.isDestroyed() || !sw || sw.isDestroyed()) return
  if (getTeachingMode() === 'teaching') return
  const sBounds = sw.getBounds()
  const wa = screen.getDisplayMatching(sBounds).workArea
  const target = wizardPetRect(sBounds, newSize, wa, petMouthY(scale))
  console.log(
    `[settings] 缩放 ${oldSize.width}×${oldSize.height} → ${newSize.width}×${newSize.height}：向导位重摆至 ${rectStr(target)}`
  )
  await runRelocateAnimation(pet, target)
}

// ------------------------------------------------------------------ 应用重启

/**
 * 重启应用（IPC.APP_RESTART → 设置页「重启」按钮，§7.6.3「无法热更的项提供重启入口」）。
 *
 * **不能用裸 app.exit**：app.exit 跳过 before-quit 的退出清理链，会留下孤儿 Python 后端进程。
 * 因此这里主动走一遍后端清理（backendManager.stop()：SIGTERM → 3s 宽限 → SIGKILL，与
 * main.ts 退出链路同一条），完成后再 app.relaunch() + app.exit(0) 强制退出
 * （exit 不触发 before-quit/will-quit——清理已先行做完，无需再走一遍）。
 */
async function restartApp(): Promise<void> {
  if (restarting) {
    console.log('[settings] 重启流程进行中，忽略重复请求')
    return
  }
  restarting = true
  console.log('[settings] 收到重启请求：先停后端子进程（防孤儿进程），再 relaunch')
  try {
    await backendManager.stop()
  } catch (err) {
    // 清理异常不阻塞重启（stop 内部有超时兜底；孤儿进程风险由 SIGKILL 兜底覆盖）
    console.error('[settings] 重启前后端清理异常（继续重启）：', err)
  }
  // 顺序固定：先登记 relaunch（以当前 argv/execPath 重启），再强制退出
  app.relaunch()
  app.exit(0)
}

// ------------------------------------------------------------------ IPC 接线（渲染 → 主）

/** sender 是否当前受管设置窗（保存上报等"设置面专属"消息只认它） */
export function isSettingsSender(sender: WebContents): boolean {
  return Boolean(
    settingsWin && !settingsWin.isDestroyed() && sender.id === settingsWin.webContents.id
  )
}

/**
 * 注册设置域 IPC 处理器（main.ts 在 app ready 后调用一次）。
 * @param pet 宠物窗口（向导广播/relocate 的对象；注入方式同 teaching 域）
 */
export function initSettings(pet: BrowserWindow): void {
  petWin = pet
  if (ipcRegistered) return
  ipcRegistered = true

  // 打开设置：托盘菜单与渲染侧（宠物面关键词「打开设置」）共用入口。
  // 无 sender 过滤：「打开设置」是无害幂等操作（重复打开收敛为聚焦），任何渲染面触发都安全
  ipcMain.on(IPC.SETTINGS_OPEN, () => {
    openSettings()
  })

  // 保存成功上报（设置面 → 主）：**保存不回位**（2026-10-16 用户定稿）——宠物留在向导位
  // 继续候命（用户可能接着改），只记日志；关闭设置窗（closed 链）才反向 relocate 回原位。
  // sender 校验：仅受管设置窗（其它渲染面误发一律忽略）
  ipcMain.on(IPC.SETTINGS_SAVED, (event) => {
    if (!isSettingsSender(event.sender)) return
    console.log('[settings] 收到设置面保存成功上报（宠物留在向导位，关闭窗口时回位）')
  })

  // 重启应用（设置页「重启」按钮）：先走后端退出清理链再 relaunch，防孤儿后端进程
  ipcMain.on(IPC.APP_RESTART, () => {
    void restartApp()
  })

  console.log('[settings] IPC 处理器已注册')
}
