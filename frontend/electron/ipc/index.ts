/**
 * IPC 域：把通道绑定到窗口能力实现。
 *
 * 依赖方向：ipc（协议层）→ window（平台能力），单向。
 * 渲染进程永远不直接操作窗口（设计文档 §1.1 核心原则 1），一律经由这里转发。
 */
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Notification,
  powerMonitor,
  shell
} from 'electron'
import { IPC, IPC_EVENTS, type PetWindowEdge, type WindowDebugState } from './channels'
import { backendManager } from '../backend-process'
import { resolveAppIconPath } from '../app-icon'
import { openConfirmBubble, setEdgeSpeechSuppression } from '../bubble'
import {
  isDangerousExecutable,
  isSafeHttpUrl,
  protectedPathReason,
  resolveExistingPath,
  type ExtraProtectedRoot
} from '../system/path-safety'
import type { Point, Rect, WindowCapability } from '../window'

/** 窗口几何推送的 debounce 时长（ms）：拖拽/缓动期间大量 move 事件只推一次最终值 */
const GEOMETRY_PUSH_DEBOUNCE_MS = 1000

/**
 * 贴边判定距离（DIP，2026-10-20）：**窗口边**距工作区边 ≤ 该值即算贴边。
 * 为什么不是按宠物模型边算：真机实测 X11/DDE 不允许窗口移出屏幕，窗口贴边时
 * 站姿宠物在窗口中间、离屏幕边约 164px，永远到不了"半个身位"。
 * 改为窗口贴边附近（8px）触发——拖拽中渲染器会把画布滑到窗口边，
 * 站姿宠物此时离屏幕边约 62~70px（≈半个身位），松手吸附后再变身边缘模型。
 */
const EDGE_TRIGGER_DISTANCE = 8

/**
 * 底部拖拽预挂距离（DIP，2026-10-20 窗口 270×240 后更新）：窗口底部空白约 32px
 * （240 − 画布底 208，输入框占 208–240）。窗口底进入屏幕底 40px 内时预挂。
 */
const EDGE_BOTTOM_PREVIEW_DISTANCE = 40

/**
 * 底部"脚碰底"吸附距离：窗口底距屏幕底 ≤4px 时，画布已挂底、宠物脚距屏幕底约 15px，
 * 视觉上就是脚碰到屏幕底——这时才出光带、松手才吸附趴睡。
 */
const EDGE_BOTTOM_SNAP_DISTANCE = 4

/** 窗口边与工作区边视为重合的容差（吸附完成后保持贴边状态用） */
const EDGE_SNAP_TOLERANCE = 2

/** 松手吸附的缓动时长（ms）：短促吸附，不拖泥带水 */
const SNAP_DURATION_MS = 160

export interface IpcContext {
  capability: WindowCapability
  window: BrowserWindow
  /** 调试态：hitbox 边框显示开关（由 main 的调试快捷键维护） */
  getHitboxVisible(): boolean
  /** 教学/工作模式：宠物固定在讲台/依附位，边缘动作应禁用（由 main 注入，避免 ipc ↔ teaching/work 循环依赖） */
  isQuietMode(): boolean
}

/** 构建窗口调试状态快照 */
function buildDebugState(ctx: IpcContext): WindowDebugState {
  return {
    clickThrough: ctx.capability.isClickThrough(),
    alwaysOnTop: ctx.capability.isAlwaysOnTop(),
    hitboxVisible: ctx.getHitboxVisible()
  }
}

/** 主动向渲染进程推送调试状态（调试快捷键触发后调用） */
export function pushDebugState(ctx: IpcContext): void {
  ctx.window.webContents.send(IPC_EVENTS.WINDOW_DEBUG_STATE_CHANGED, buildDebugState(ctx))
}

/** 主进程侧额外受保护目录：小兔自己的安装/数据/日志目录（删了会把宠物弄坏） */
function extraProtectedRoots(): ExtraProtectedRoot[] {
  const roots: ExtraProtectedRoot[] = []
  const add = (raw: string | undefined, reason: string): void => {
    if (!raw) return
    roots.push({ path: raw, descendants: true, reason })
  }
  add(app.getAppPath(), '这是小兔的程序目录')
  add(app.getPath('userData'), '这是小兔的数据目录')
  try {
    add(app.getPath('logs'), '这是小兔的日志目录')
  } catch {
    // 某些平台/配置下没有 logs 路径——忽略
  }
  return roots
}

/** 注册全部 IPC 处理器（主进程在窗口创建后调用一次） */
export function registerIpcHandlers(ctx: IpcContext): void {
  const { capability: cap } = ctx

  ipcMain.on(IPC.WINDOW_SET_CLICK_THROUGH, (_event, on: boolean) => {
    cap.setClickThrough(on)
  })

  ipcMain.on(IPC.WINDOW_DRAG_START, (_event, cursor: Point) => {
    // 吸附缓动还在跑时用户又抓起宠物：取消 moveTo，避免与拖拽抢窗口控制权
    cap.cancelMove()
    // 拖起宠物 = 解除吸附保持；站姿宠物框重新参与判定（吸附状态在拖拽中不再适用）
    snapping = false
    snappedEdge = 'none'
    dragging = true
    cap.startDrag(cursor)
    pushWindowEdge()
  })

  ipcMain.on(IPC.WINDOW_DRAG_MOVE, (_event, cursor: Point) => {
    cap.dragMove(cursor)
  })

  ipcMain.on(IPC.WINDOW_DRAG_END, () => {
    cap.endDrag()
    // 先退出拖拽预挂阈值（底部回到"脚碰底"判定），再决定吸附/回中
    dragging = false
    snapToEdge()
    // 没碰到屏幕底（预挂区里松手）→ 清掉边缘，宠物和输入框恢复原位
    if (snappedEdge === 'none') pushWindowEdge()
  })

  ipcMain.on(IPC.WINDOW_REPORT_INTERACTIVE_RECTS, (_event, rects: Rect[]) => {
    // 可选能力：仅 Linux 实现（X11 形状穿透）
    cap.setInteractiveRects?.(rects)
  })

  ipcMain.handle(IPC.WINDOW_GET_DEBUG_STATE, () => buildDebugState(ctx))

  // P3 行为引擎：缓动移动（invoke 配对一次移动；完成/取消 resolve）
  ipcMain.handle(IPC.WINDOW_MOVE_TO, (_event, x: number, y: number, durationMs: number) =>
    cap.moveTo(x, y, durationMs)
  )
  ipcMain.on(IPC.WINDOW_MOVE_CANCEL, () => {
    cap.cancelMove()
  })
  ipcMain.handle(IPC.WINDOW_GET_GEOMETRY, () => cap.getGeometry())
  ipcMain.handle(
    IPC.WINDOW_IS_VISIBLE,
    () => !ctx.window.isDestroyed() && ctx.window.isVisible()
  )
  ipcMain.handle(IPC.SYSTEM_GET_IDLE_SECONDS, () => powerMonitor.getSystemIdleTime())

  // 系统通知（提醒 v1）：只认宠物窗，防其它渲染面（黑板/设置）滥用；
  // 宠物隐藏 / 教学 / 向导中无法弹气泡时补发，标题/正文做长度夹取。
  ipcMain.on(IPC.SYSTEM_NOTIFY, (event, payload: { title?: unknown; body?: unknown }) => {
    if (event.sender !== ctx.window.webContents) return
    const title = typeof payload?.title === 'string' ? payload.title.slice(0, 80) : '小兔'
    const body = typeof payload?.body === 'string' ? payload.body.slice(0, 300) : ''
    if (!body || !Notification.isSupported()) {
      console.warn(`[ipc] 系统通知被跳过（body 空或平台不支持 supported=${Notification.isSupported()}）`)
      return
    }
    // icon：通知中心显示兔子图标（Linux 走 image-path hint）。不传时 DDE 会回退到
    // Electron 默认图标（用户 2026-10-21 反馈通知里是默认方块）。
    new Notification({ title, body, icon: resolveAppIconPath() }).show()
    console.log(`[ipc] 系统通知：${title} / ${body}`)
  })

  // ---------------------------------------------------------------- 记忆本（2026-10-18）
  // 外链/本机路径打开 + 删除真实文件。安全边界：
  // - 打开外链只放行 http/https；
  // - 打开文件拒绝可执行/脚本类（防“打开”变“运行”）；
  // - 删除必须先经确认（宠物面=气泡，设置面=原生对话框），且主进程再判一次
  //   受保护目录；执行用 shell.trashItem（系统回收站，可恢复），不做永久删除。

  ipcMain.handle(IPC.SYSTEM_OPEN_EXTERNAL, async (_event, url: unknown) => {
    if (!isSafeHttpUrl(url)) {
      return { ok: false, message: '只能打开 http/https 网页链接' }
    }
    try {
      await shell.openExternal(String(url).trim())
      return { ok: true }
    } catch (err) {
      return { ok: false, message: `打不开这个链接：${(err as Error).message}` }
    }
  })

  ipcMain.handle(IPC.SYSTEM_OPEN_PATH, async (_event, raw: unknown) => {
    try {
      const checked = resolveExistingPath(raw)
      if (isDangerousExecutable(checked.path, checked.isDir)) {
        return {
          ok: false,
          message: '为了安全，小兔不直接打开可执行文件或脚本；可以在文件管理器里打开。'
        }
      }
      const error = await shell.openPath(checked.path)
      return error ? { ok: false, message: `打不开：${error}` } : { ok: true }
    } catch (err) {
      return { ok: false, message: (err as Error).message || '这个路径现在用不了' }
    }
  })

  /** 删除前的公共校验：存在 + 非受保护目录；返回归一化路径或错误结果。 */
  const checkDeletable = (
    raw: unknown
  ): { ok: true; path: string; isDir: boolean } | { ok: false; message: string } => {
    try {
      const checked = resolveExistingPath(raw)
      const reason = protectedPathReason(checked.path, extraProtectedRoots())
      if (reason) {
        return { ok: false, message: `这个路径不能删：${reason}\n${checked.path}` }
      }
      return { ok: true, path: checked.path, isDir: checked.isDir }
    } catch (err) {
      return { ok: false, message: (err as Error).message || '这个路径现在用不了' }
    }
  }

  // 宠物面：先弹气泡确认，用户点「删除」才移入回收站
  ipcMain.handle(
    IPC.SYSTEM_DELETE_PATH_CONFIRM,
    async (event, payload: { path?: unknown; name?: unknown } | null) => {
      if (event.sender !== ctx.window.webContents) {
        return { confirmed: false, ok: false, message: '无权执行这个操作' }
      }
      const rawPath = typeof payload?.path === 'string' ? payload.path : ''
      const itemName =
        typeof payload?.name === 'string' ? payload.name.trim().slice(0, 60) : ''
      const checked = checkDeletable(rawPath)
      if (!checked.ok) {
        return { confirmed: false, ok: false, message: checked.message }
      }

      const label = itemName
        ? `『${itemName}』`
        : checked.isDir
          ? '这个文件夹'
          : '这个文件'
      const message =
        `要删除${label}吗？\n${checked.path}\n` +
        `${checked.isDir ? '文件夹及里面所有内容会' : '会'}放进回收站，可以恢复。`
      const confirmed = await openConfirmBubble({
        message,
        confirmLabel: '删除',
        cancelLabel: '取消'
      })
      if (!confirmed) {
        return { confirmed: false, ok: false }
      }

      // 确认后重新校验：路径可能在弹窗期间被移动/替换
      const rechecked = checkDeletable(checked.path)
      if (!rechecked.ok) {
        return { confirmed: true, ok: false, message: rechecked.message }
      }
      try {
        await shell.trashItem(rechecked.path)
        console.log(`[ipc] 已移入回收站：${rechecked.path}`)
        return { confirmed: true, ok: true }
      } catch (err) {
        return {
          confirmed: true,
          ok: false,
          message: `删除失败：${(err as Error).message || err}`
        }
      }
    }
  )

  // 设置面：原生确认框（删除/取消），确认后同样移入回收站
  ipcMain.handle(IPC.SETTINGS_DELETE_PATH, async (event, raw: unknown) => {
    const checked = checkDeletable(raw)
    if (!checked.ok) {
      return { confirmed: false, ok: false, message: checked.message }
    }
    const options: Electron.MessageBoxOptions = {
      type: 'warning',
      buttons: ['删除', '取消'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      message: `要删除这个${checked.isDir ? '文件夹' : '文件'}吗？`,
      detail:
        `${checked.path}\n\n` +
        `${checked.isDir ? '文件夹及里面所有内容会' : '会'}放进回收站，可以恢复。`
    }
    const parent = BrowserWindow.fromWebContents(event.sender)
    const response = parent
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options)
    if (response.response !== 0) {
      return { confirmed: false, ok: false }
    }

    const rechecked = checkDeletable(checked.path)
    if (!rechecked.ok) {
      return { confirmed: true, ok: false, message: rechecked.message }
    }
    try {
      await shell.trashItem(rechecked.path)
      console.log(`[ipc] 已移入回收站（设置页）：${rechecked.path}`)
      return { confirmed: true, ok: true }
    } catch (err) {
      return {
        confirmed: true,
        ok: false,
        message: `删除失败：${(err as Error).message || err}`
      }
    }
  })

  // 窗口几何变化 → debounce 后推送（拖拽/缓动/系统移动统一收口，渲染侧据此上报 env_update）
  let geometryPushTimer: NodeJS.Timeout | null = null
  const scheduleGeometryPush = (): void => {
    if (geometryPushTimer) clearTimeout(geometryPushTimer)
    geometryPushTimer = setTimeout(() => {
      geometryPushTimer = null
      if (ctx.window.isDestroyed()) return
      ctx.window.webContents.send(IPC_EVENTS.WINDOW_GEOMETRY_CHANGED, cap.getGeometry())
    }, GEOMETRY_PUSH_DEBOUNCE_MS)
  }
  ctx.window.on('move', scheduleGeometryPush)
  ctx.window.on('resize', scheduleGeometryPush)

  // 窗口贴边状态 → 实时推送（2026-10-20）：判定按**宠物模型**边缘（PET_VISUAL_BOX），
  // 而不是 400×400 的窗口边——窗口比宠物大，按窗口边会在宠物离屏幕边还有一个多身位时提前触发。
  // 仅在状态变化时发，避免拖拽期间每帧 IPC 噪声；顶部优先（角落同时贴顶/贴边时显示悬挂）。
  let lastEdge: PetWindowEdge = 'none'
  let lastNear = false
  /** 已吸附边缘：窗口贴边后画布已挂边、站姿宠物框不再适用，保持该状态直到窗口离开 */
  let snappedEdge: PetWindowEdge = 'none'
  /** 吸附缓动进行中：期间保持 snappedEdge，避免 move 事件中途把状态清掉 */
  let snapping = false
  /** 用户拖拽中：底部预挂（160px）只在拖拽阶段生效，松手后回到脚碰底判定 */
  let dragging = false

  /** 窗口是否仍贴在指定边上（吸附保持判定；必须按同一方向判断，否则会因其它边贴边而误保持） */
  function windowAtEdge(edge: PetWindowEdge): boolean {
    const b = ctx.window.getBounds()
    const wa = cap.getWorkArea()
    switch (edge) {
      case 'top':
        return Math.abs(b.y - wa.y) <= EDGE_SNAP_TOLERANCE
      case 'left':
        return Math.abs(b.x - wa.x) <= EDGE_SNAP_TOLERANCE
      case 'right':
        return Math.abs(b.x + b.width - (wa.x + wa.width)) <= EDGE_SNAP_TOLERANCE
      case 'bottom':
        return Math.abs(b.y + b.height - (wa.y + wa.height)) <= EDGE_SNAP_TOLERANCE
      default:
        return false
    }
  }
  function computeWindowEdge(): PetWindowEdge {
    // 教学/工作模式：宠物固定在讲台位/工作窗左侧，禁用边缘动作
    // （讲台位窗口底会越过工作区底，不禁用会被误判成底部趴睡）
    if (ctx.isQuietMode()) return 'none'
    if (snapping) return snappedEdge
    if (snappedEdge !== 'none') {
      if (windowAtEdge(snappedEdge)) return snappedEdge
      snappedEdge = 'none'
    }
    const bounds = ctx.window.getBounds()
    const wa = cap.getWorkArea()
    // 窗口与工作区必须相交：完全拖出屏幕（如副屏间隙）时不触发
    const overlapX = bounds.x + bounds.width > wa.x && bounds.x < wa.x + wa.width
    const overlapY = bounds.y + bounds.height > wa.y && bounds.y < wa.y + wa.height
    if (!overlapX || !overlapY) return 'none'
    if (bounds.y <= wa.y + EDGE_TRIGGER_DISTANCE) return 'top'
    if (bounds.x <= wa.x + EDGE_TRIGGER_DISTANCE) return 'left'
    if (bounds.x + bounds.width >= wa.x + wa.width - EDGE_TRIGGER_DISTANCE) return 'right'
    // 底部：拖拽中先预挂（160px 内滑画布，宠物脚跟着靠近屏幕底）；松手/静止时只认脚碰底（4px）
    const bottomThreshold = dragging ? EDGE_BOTTOM_PREVIEW_DISTANCE : EDGE_BOTTOM_SNAP_DISTANCE
    if (bounds.y + bounds.height >= wa.y + wa.height - bottomThreshold) return 'bottom'
    return 'none'
  }
  /** 窗口是否真正贴住对应工作区边（≤8px）：区分"底部预挂跟随"与"可吸附" */
  function computeNearSnap(edge: PetWindowEdge): boolean {
    if (edge === 'none') return false
    const b = ctx.window.getBounds()
    const wa = cap.getWorkArea()
    switch (edge) {
      case 'top':
        return b.y <= wa.y + EDGE_TRIGGER_DISTANCE
      case 'left':
        return b.x <= wa.x + EDGE_TRIGGER_DISTANCE
      case 'right':
        return b.x + b.width >= wa.x + wa.width - EDGE_TRIGGER_DISTANCE
      case 'bottom':
        return b.y + b.height >= wa.y + wa.height - EDGE_BOTTOM_SNAP_DISTANCE
      default:
        return false
    }
  }
  function pushWindowEdge(): void {
    if (ctx.window.isDestroyed()) return
    const edge = computeWindowEdge()
    const near = computeNearSnap(edge)
    // 贴上/下边吸附时抑制聊天气泡（2026-10-20 用户需求）：吸附后气泡只能压在兔子身上
    // （上边翻到下方、下边压在头上）；左右吸附气泡横向错开，照常显示。
    // 拖拽中不抑制（气泡照常跟随），松手吸附瞬间即收起；离开上/下边后自动恢复内容。
    const suppressSpeech =
      !dragging && (edge === 'top' || edge === 'bottom') && (near || snappedEdge === edge)
    setEdgeSpeechSuppression(suppressSpeech)
    if (edge === lastEdge && near === lastNear) return
    lastEdge = edge
    lastNear = near
    ctx.window.webContents.send(IPC_EVENTS.WINDOW_EDGE_CHANGED, { edge, near })
  }
  /**
   * 拖拽松手吸附（2026-10-20）：判定按宠物模型边缘（半个身位），吸附目标是把**窗口**
   * 贴到工作区边——吸附后画布挂边、边缘模型贴屏幕边（窗口比宠物大，窗口必须贴边）。
   * 角落同时补 x/y；短缓动，不瞬跳。
   */
  function snapToEdge(): void {
    if (ctx.window.isDestroyed()) return
    const edge = computeWindowEdge()
    if (edge === 'none') return
    const bounds = ctx.window.getBounds()
    const wa = cap.getWorkArea()
    let x = bounds.x
    let y = bounds.y
    if (bounds.y <= wa.y + EDGE_TRIGGER_DISTANCE) {
      y = wa.y
    } else if (bounds.y + bounds.height >= wa.y + wa.height - EDGE_BOTTOM_SNAP_DISTANCE) {
      // 底部趴睡：吸附到工作区底边（任务栏/Dock 上方）
      y = wa.y + wa.height - bounds.height
    }
    if (bounds.x <= wa.x + EDGE_TRIGGER_DISTANCE) {
      x = wa.x
    } else if (bounds.x + bounds.width >= wa.x + wa.width - EDGE_TRIGGER_DISTANCE) {
      x = wa.x + wa.width - bounds.width
    }
    snappedEdge = edge
    if (x === bounds.x && y === bounds.y) {
      pushWindowEdge()
      return
    }
    snapping = true
    void cap.moveTo(x, y, SNAP_DURATION_MS).then(() => {
      snapping = false
      if (!ctx.window.isDestroyed()) pushWindowEdge()
    })
  }
  ctx.window.on('move', pushWindowEdge)
  ctx.window.on('resize', pushWindowEdge)

  // 后端状态快照：渲染进程晚于 ready 订阅时补状态（否则会漏掉一次性 ready 事件）
  ipcMain.handle(IPC.BACKEND_GET_SNAPSHOT, () => backendManager.getSnapshot())
}
