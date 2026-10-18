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
import { IPC, IPC_EVENTS, type WindowDebugState } from './channels'
import { backendManager } from '../backend-process'
import { openConfirmBubble } from '../bubble'
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

export interface IpcContext {
  capability: WindowCapability
  window: BrowserWindow
  /** 调试态：hitbox 边框显示开关（由 main 的调试快捷键维护） */
  getHitboxVisible(): boolean
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
    cap.startDrag(cursor)
  })

  ipcMain.on(IPC.WINDOW_DRAG_MOVE, (_event, cursor: Point) => {
    cap.dragMove(cursor)
  })

  ipcMain.on(IPC.WINDOW_DRAG_END, () => {
    cap.endDrag()
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
    if (!body || !Notification.isSupported()) return
    new Notification({ title, body }).show()
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

  // 后端状态快照：渲染进程晚于 ready 订阅时补状态（否则会漏掉一次性 ready 事件）
  ipcMain.handle(IPC.BACKEND_GET_SNAPSHOT, () => backendManager.getSnapshot())
}
