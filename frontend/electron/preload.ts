/**
 * preload：contextBridge 安全桥（只暴露白名单 API，设计文档 §2.2）。
 * 渲染进程只能访问 window.pet，无法触达 Node / Electron 原生能力。
 */
import { clipboard, contextBridge, ipcRenderer, webUtils } from 'electron'
import {
  IPC,
  IPC_BUBBLE,
  IPC_EVENTS,
  IPC_BALL_ANIMATION,
  IPC_REMINDER_LIST,
  IPC_WORK,
  type BackendReadyPayload,
  type BackendSnapshot,
  type BackendStatusPayload,
  type BubbleOpenPayload,
  type BubbleRequest,
  type BubbleSayBeginPayload,
  type BubbleSpeechEventPayload,
  type BubbleSpeechMeta,
  type BubbleTail,
  type BubbleUpdatePayload,
  type BallAnimationCommand,
  type BallAnimationPetReactionPayload,
  type DeletePathResult,
  type FramelessMovePayload,
  type FramelessResizePayload,
  type LauncherListRequest,
  type LauncherListResult,
  type LauncherRunRequest,
  type LauncherRunResult,
  type OpenResult,
  type PetBridgeApi,
  type PetSayLinePayload,
  type WindowEdgePayload,
  type PickedFile,
  type ReminderListActionPayload,
  type ReminderListOpenPayload,
  type ReminderListUpdatePayload,
  type SettingsVisibilityPayload,
  type TeachingBoardInbox,
  type TeachingEnterReason,
  type TeachingMirrorEvent,
  type TeachingSendRequestPayload,
  type TeachingStatePayload,
  type TrayMenuAction,
  type WindowDebugState,
  type WorkBrowserAction,
  type WorkBrowserOpenPayload,
  type WorkBrowserState,
  type WorkHistoryPayload,
  type WorkHistoryRequestPayload,
  type WorkMirrorEvent,
  type WorkPresencePayload,
  type WorkSendRequestPayload,
  type WorkSendResultPayload
} from './ipc/channels'
import { PLATFORM } from './platform'
import type { MoveResult, Point, Rect, WindowGeometry } from './window'

const api: PetBridgeApi = {
  platform: PLATFORM,

  window: {
    setClickThrough(on: boolean): void {
      ipcRenderer.send(IPC.WINDOW_SET_CLICK_THROUGH, on)
    },

    startDrag(cursor: Point): void {
      ipcRenderer.send(IPC.WINDOW_DRAG_START, cursor)
    },

    dragMove(cursor: Point): void {
      ipcRenderer.send(IPC.WINDOW_DRAG_MOVE, cursor)
    },

    endDrag(): void {
      ipcRenderer.send(IPC.WINDOW_DRAG_END)
    },

    reportInteractiveRects(rects: Rect[]): void {
      ipcRenderer.send(IPC.WINDOW_REPORT_INTERACTIVE_RECTS, rects)
    },

    getDebugState(): Promise<WindowDebugState> {
      return ipcRenderer.invoke(IPC.WINDOW_GET_DEBUG_STATE)
    },

    onDebugStateChanged(cb: (state: WindowDebugState) => void): () => void {
      const listener = (_event: Electron.IpcRendererEvent, state: WindowDebugState): void => cb(state)
      ipcRenderer.on(IPC_EVENTS.WINDOW_DEBUG_STATE_CHANGED, listener)
      return () => {
        ipcRenderer.removeListener(IPC_EVENTS.WINDOW_DEBUG_STATE_CHANGED, listener)
      }
    },

    onToggleDebugBar(cb: () => void): () => void {
      const listener = (): void => cb()
      ipcRenderer.on(IPC_EVENTS.WINDOW_TOGGLE_DEBUG_BAR, listener)
      return () => {
        ipcRenderer.removeListener(IPC_EVENTS.WINDOW_TOGGLE_DEBUG_BAR, listener)
      }
    },

    moveTo(x: number, y: number, durationMs: number): Promise<MoveResult> {
      return ipcRenderer.invoke(IPC.WINDOW_MOVE_TO, x, y, durationMs)
    },

    cancelMove(): void {
      ipcRenderer.send(IPC.WINDOW_MOVE_CANCEL)
    },

    getGeometry(): Promise<WindowGeometry> {
      return ipcRenderer.invoke(IPC.WINDOW_GET_GEOMETRY)
    },

    isVisible(): Promise<boolean> {
      return ipcRenderer.invoke(IPC.WINDOW_IS_VISIBLE)
    },

    onGeometryChanged(cb: (geo: WindowGeometry) => void): () => void {
      const listener = (_event: Electron.IpcRendererEvent, geo: WindowGeometry): void => cb(geo)
      ipcRenderer.on(IPC_EVENTS.WINDOW_GEOMETRY_CHANGED, listener)
      return () => {
        ipcRenderer.removeListener(IPC_EVENTS.WINDOW_GEOMETRY_CHANGED, listener)
      }
    },

    onEdgeChanged(cb: (payload: WindowEdgePayload) => void): () => void {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: WindowEdgePayload
      ): void => cb(payload)
      ipcRenderer.on(IPC_EVENTS.WINDOW_EDGE_CHANGED, listener)
      return () => {
        ipcRenderer.removeListener(IPC_EVENTS.WINDOW_EDGE_CHANGED, listener)
      }
    },

    /** 空气让路（§5.1 增补）：上报光标处命中判定（true=实体/交互元素，false=空气区） */
    reportHitTest(solid: boolean): void {
      ipcRenderer.send(IPC.PET_REPORT_HIT_TEST, { solid })
    },

    /** 空气让路（§5.1 增补）：订阅主进程推送的光标窗口内坐标（让路态轮询推送；null=光标出窗） */
    onPointerPos(cb: (pos: { x: number; y: number } | null) => void): () => void {
      const listener = (
        _event: Electron.IpcRendererEvent,
        pos: { x: number; y: number } | null
      ): void => cb(pos)
      ipcRenderer.on(IPC_EVENTS.PET_POINTER_POS, listener)
      return () => {
        ipcRenderer.removeListener(IPC_EVENTS.PET_POINTER_POS, listener)
      }
    }
  },

  // 无边框窗口通用拖动/缩放（shared/ui 的 WindowTitleBar / WindowResizeHandles 调用；
  // 仅 attachFrameless 注册过的窗口生效）
  frameless: {
    move(payload: FramelessMovePayload): void {
      ipcRenderer.send(IPC.WINDOW_CHROME_MOVE, payload)
    },

    resize(payload: FramelessResizePayload): void {
      ipcRenderer.send(IPC.WINDOW_CHROME_RESIZE, payload)
    }
  },

  system: {
    getIdleSeconds(): Promise<number> {
      return ipcRenderer.invoke(IPC.SYSTEM_GET_IDLE_SECONDS)
    },

    notify(title: string, body: string): void {
      ipcRenderer.send(IPC.SYSTEM_NOTIFY, { title, body })
    },

    /** 用系统默认浏览器打开 http/https 链接（主进程做 scheme 白名单） */
    openExternal(url: string): Promise<OpenResult> {
      return ipcRenderer.invoke(IPC.SYSTEM_OPEN_EXTERNAL, url)
    },

    /** 写系统剪贴板（工作模式复制消息） */
    copyText(text: string): void {
      clipboard.writeText(String(text))
    },

    /** 用默认程序打开本机文件/文件夹（主进程拒绝可执行/脚本类） */
    openPath(path: string): Promise<OpenResult> {
      return ipcRenderer.invoke(IPC.SYSTEM_OPEN_PATH, path)
    },

    /** 宠物面：删除本机文件/文件夹（先弹气泡确认；确认后移入回收站） */
    deletePathWithConfirm(path: string, name?: string): Promise<DeletePathResult> {
      return ipcRenderer.invoke(IPC.SYSTEM_DELETE_PATH_CONFIRM, { path, name })
    }
  },

  launcher: {
    /** 已安装应用列表（设置页选择器；主进程扫描 .desktop 并缓存） */
    listApps(request?: LauncherListRequest): Promise<LauncherListResult> {
      return ipcRenderer.invoke(IPC.LAUNCHER_LIST_APPS, request ?? {})
    },

    /** 启动程序：按应用名或绝对路径（临时路径由主进程弹确认气泡） */
    runProgram(request: LauncherRunRequest): Promise<LauncherRunResult> {
      return ipcRenderer.invoke(IPC.LAUNCHER_RUN, request)
    }
  },

  files: {
    pick(): Promise<PickedFile[]> {
      return ipcRenderer.invoke(IPC.FILES_PICK)
    },
    stat(path: string): Promise<PickedFile | null> {
      return ipcRenderer.invoke(IPC.FILES_STAT, path)
    },
    pathFor(file: File): string {
      try {
        return webUtils.getPathForFile(file)
      } catch {
        return ''
      }
    }
  },

  ballAnimation: {
    ready(): void {
      ipcRenderer.send(IPC_BALL_ANIMATION.READY)
    },

    onCommand(cb: (cmd: BallAnimationCommand) => void): () => void {
      const listener = (_event: Electron.IpcRendererEvent, cmd: BallAnimationCommand): void => cb(cmd)
      ipcRenderer.on(IPC_BALL_ANIMATION.COMMAND, listener)
      return () => {
        ipcRenderer.removeListener(IPC_BALL_ANIMATION.COMMAND, listener)
      }
    },

    onPetReaction(cb: (payload: BallAnimationPetReactionPayload) => void): () => void {
      const listener = (_event: Electron.IpcRendererEvent, payload: BallAnimationPetReactionPayload): void =>
        cb(payload)
      ipcRenderer.on(IPC_EVENTS.PET_FX_REACTION, listener)
      return () => {
        ipcRenderer.removeListener(IPC_EVENTS.PET_FX_REACTION, listener)
      }
    }
  },

  lifecycle: {
    onSay(cb: (payload: PetSayLinePayload) => void): () => void {
      const listener = (_event: Electron.IpcRendererEvent, payload: PetSayLinePayload): void =>
        cb(payload)
      ipcRenderer.on(IPC_EVENTS.PET_SAY_LINE, listener)
      return () => {
        ipcRenderer.removeListener(IPC_EVENTS.PET_SAY_LINE, listener)
      }
    }
  },

  teaching: {
    getState(): Promise<TeachingStatePayload> {
      return ipcRenderer.invoke(IPC.TEACHING_GET_STATE)
    },

    onState(cb: (state: TeachingStatePayload) => void): () => void {
      const listener = (_event: Electron.IpcRendererEvent, state: TeachingStatePayload): void =>
        cb(state)
      ipcRenderer.on(IPC_EVENTS.TEACHING_STATE_CHANGED, listener)
      return () => {
        ipcRenderer.removeListener(IPC_EVENTS.TEACHING_STATE_CHANGED, listener)
      }
    },

    enter(reason: TeachingEnterReason): void {
      ipcRenderer.send(IPC.TEACHING_ENTER, reason)
    },

    exit(): void {
      ipcRenderer.send(IPC.TEACHING_EXIT)
    },

    reportMirror(event: TeachingMirrorEvent): void {
      ipcRenderer.send(IPC.TEACHING_REPORT_MIRROR, event)
    },

    goto(messageId: string): void {
      ipcRenderer.send(IPC.TEACHING_GOTO, messageId)
    },

    notifyDragStart(): void {
      ipcRenderer.send(IPC.TEACHING_DRAG_START)
    },

    requestSend(text: string, attachments: { path: string; name: string }[] = []): void {
      ipcRenderer.send(IPC.TEACHING_REQUEST_SEND, { text, attachments })
    },

    onSendRequest(cb: (payload: TeachingSendRequestPayload) => void): () => void {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: TeachingSendRequestPayload
      ): void => cb(payload)
      ipcRenderer.on(IPC_EVENTS.TEACHING_SEND_REQUEST, listener)
      return () => {
        ipcRenderer.removeListener(IPC_EVENTS.TEACHING_SEND_REQUEST, listener)
      }
    },

    requestUnfold(): void {
      ipcRenderer.send(IPC.TEACHING_REQUEST_UNFOLD)
    },

    ready(): void {
      ipcRenderer.send(IPC.TEACHING_READY)
    },

    onBoardInbox(cb: (item: TeachingBoardInbox) => void): () => void {
      const listener = (_event: Electron.IpcRendererEvent, item: TeachingBoardInbox): void =>
        cb(item)
      ipcRenderer.on(IPC_EVENTS.TEACHING_BOARD_INBOX, listener)
      return () => {
        ipcRenderer.removeListener(IPC_EVENTS.TEACHING_BOARD_INBOX, listener)
      }
    }
  },

  settings: {
    open(): void {
      ipcRenderer.send(IPC.SETTINGS_OPEN)
    },

    notifySaved(): void {
      ipcRenderer.send(IPC.SETTINGS_SAVED)
    },

    onVisibility(cb: (payload: SettingsVisibilityPayload) => void): () => void {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: SettingsVisibilityPayload
      ): void => cb(payload)
      ipcRenderer.on(IPC_EVENTS.SETTINGS_VISIBILITY, listener)
      return () => {
        ipcRenderer.removeListener(IPC_EVENTS.SETTINGS_VISIBILITY, listener)
      }
    },

    /** 设置面：删除本机文件/文件夹（主进程原生确认框；确认后移入回收站） */
    deletePath(path: string): Promise<DeletePathResult> {
      return ipcRenderer.invoke(IPC.SETTINGS_DELETE_PATH, path)
    }
  },

  /** 自绘托盘菜单窗（§7.6.4 v2）：菜单窗 → 主 动作；主 → 菜单窗 每次弹出前的初始化载荷 */
  trayMenu: {
    action(a: TrayMenuAction): void {
      ipcRenderer.send(IPC.TRAY_MENU_ACTION, a)
    },

    onInit(cb: (payload: { petVisible: boolean }) => void): () => void {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: { petVisible: boolean }
      ): void => cb(payload)
      ipcRenderer.on(IPC_EVENTS.TRAY_MENU_INIT, listener)
      return () => {
        ipcRenderer.removeListener(IPC_EVENTS.TRAY_MENU_INIT, listener)
      }
    }
  },

  /**
   * 气泡系统：宠物面 requestOpen（请求弹出）+ 说话气泡（sayBegin/sayText/sayEnd）+
   * 气泡面整套协议（ready/尺寸上报/动作/收起回报 + 订阅）。
   * 同一份 preload 注入到所有渲染窗——各方法在"非本面"窗口调用为无害空操作（主进程按 sender 过滤）。
   */
  bubble: {
    requestOpen(request: BubbleRequest): void {
      ipcRenderer.send(IPC.BUBBLE_REQUEST_OPEN, request)
    },

    sayBegin(meta?: BubbleSpeechMeta): void {
      const payload: BubbleSayBeginPayload = { meta }
      ipcRenderer.send(IPC_BUBBLE.SAY_BEGIN, payload)
    },

    sayText(text: string): void {
      ipcRenderer.send(IPC_BUBBLE.SAY_TEXT, { text })
    },

    sayEnd(immediate = false): void {
      ipcRenderer.send(IPC_BUBBLE.SAY_END, { immediate })
    },

    setIdleTimeout(seconds: number): void {
      ipcRenderer.send(IPC_BUBBLE.SET_IDLE_TTL, seconds)
    },

    setNextSpeechTtl(ms: number): void {
      ipcRenderer.send(IPC_BUBBLE.SET_NEXT_SPEECH_TTL, ms)
    },

    touchSpeech(): void {
      ipcRenderer.send(IPC_BUBBLE.SPEECH_TOUCH)
    },

    reportSpeechActivity(paused: boolean): void {
      ipcRenderer.send(IPC_BUBBLE.SPEECH_ACTIVITY, { paused: Boolean(paused) })
    },

    requestContextMenu(selectionText: string): void {
      ipcRenderer.send(IPC_BUBBLE.REQUEST_CONTEXT_MENU, {
        selectionText: String(selectionText ?? '')
      })
    },

    ready(): void {
      ipcRenderer.send(IPC_BUBBLE.READY)
    },

    reportSize(size: { width: number; height: number }): void {
      ipcRenderer.send(IPC_BUBBLE.REPORT_SIZE, size)
    },

    reportShape(rects: Rect[]): void {
      ipcRenderer.send(IPC_BUBBLE.REPORT_SHAPE, rects)
    },

    action(id: string): void {
      ipcRenderer.send(IPC_BUBBLE.ACTION, id)
    },

    notifyClosed(): void {
      ipcRenderer.send(IPC_BUBBLE.CLOSED)
    },

    onOpen(cb: (payload: BubbleOpenPayload) => void): () => void {
      const listener = (_event: Electron.IpcRendererEvent, payload: BubbleOpenPayload): void =>
        cb(payload)
      ipcRenderer.on(IPC_BUBBLE.OPEN, listener)
      return () => {
        ipcRenderer.removeListener(IPC_BUBBLE.OPEN, listener)
      }
    },

    onUpdate(cb: (payload: BubbleUpdatePayload) => void): () => void {
      const listener = (_event: Electron.IpcRendererEvent, payload: BubbleUpdatePayload): void =>
        cb(payload)
      ipcRenderer.on(IPC_BUBBLE.UPDATE, listener)
      return () => {
        ipcRenderer.removeListener(IPC_BUBBLE.UPDATE, listener)
      }
    },

    onRequestClose(cb: () => void): () => void {
      const listener = (): void => cb()
      ipcRenderer.on(IPC_BUBBLE.REQUEST_CLOSE, listener)
      return () => {
        ipcRenderer.removeListener(IPC_BUBBLE.REQUEST_CLOSE, listener)
      }
    },

    onSetTail(cb: (tail: BubbleTail) => void): () => void {
      const listener = (_event: Electron.IpcRendererEvent, tail: BubbleTail): void => cb(tail)
      ipcRenderer.on(IPC_BUBBLE.SET_TAIL, listener)
      return () => {
        ipcRenderer.removeListener(IPC_BUBBLE.SET_TAIL, listener)
      }
    },

    onSpeechEvent(cb: (payload: BubbleSpeechEventPayload) => void): () => void {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: BubbleSpeechEventPayload
      ): void => cb(payload)
      ipcRenderer.on(IPC_EVENTS.BUBBLE_SPEECH_EVENT, listener)
      return () => {
        ipcRenderer.removeListener(IPC_EVENTS.BUBBLE_SPEECH_EVENT, listener)
      }
    }
  },

  /** 提醒列表窗：宠物面推送未读快照 + 接收列表页动作（主进程摆窗/转发） */
  reminderList: {
    update(payload: ReminderListUpdatePayload): void {
      ipcRenderer.send(IPC_REMINDER_LIST.UPDATE, payload)
    },

    ready(): void {
      ipcRenderer.send(IPC_REMINDER_LIST.READY)
    },

    reportSize(size: { width: number; height: number }): void {
      ipcRenderer.send(IPC_REMINDER_LIST.REPORT_SIZE, size)
    },

    action(payload: ReminderListActionPayload): void {
      ipcRenderer.send(IPC_REMINDER_LIST.ACTION, payload)
    },

    contextMenu(): void {
      ipcRenderer.send(IPC_REMINDER_LIST.CONTEXT_MENU)
    },

    onOpen(cb: (payload: ReminderListOpenPayload) => void): () => void {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: ReminderListOpenPayload
      ): void => cb(payload)
      ipcRenderer.on(IPC_REMINDER_LIST.OPEN, listener)
      return () => {
        ipcRenderer.removeListener(IPC_REMINDER_LIST.OPEN, listener)
      }
    },

    onAction(cb: (payload: ReminderListActionPayload) => void): () => void {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: ReminderListActionPayload
      ): void => cb(payload)
      ipcRenderer.on(IPC_EVENTS.REMINDER_LIST_ACTION, listener)
      return () => {
        ipcRenderer.removeListener(IPC_EVENTS.REMINDER_LIST_ACTION, listener)
      }
    }
  },

  /** 工作模式（独立聊天窗，2026-10-18）：发送/历史/镜像经主进程中继 */
  work: {
    open(): void {
      ipcRenderer.send(IPC_WORK.OPEN)
    },

    hide(): void {
      ipcRenderer.send(IPC_WORK.HIDE)
    },

    minimize(): void {
      ipcRenderer.send(IPC_WORK.MINIMIZE)
    },

    ready(): void {
      ipcRenderer.send(IPC_WORK.READY)
    },

    requestSend(payload: WorkSendRequestPayload): Promise<WorkSendResultPayload> {
      return ipcRenderer.invoke(IPC_WORK.REQUEST_SEND, payload)
    },

    requestHistory(payload: WorkHistoryRequestPayload): Promise<WorkHistoryPayload> {
      return ipcRenderer.invoke(IPC_WORK.REQUEST_HISTORY, payload)
    },

    interrupt(): void {
      ipcRenderer.send(IPC_WORK.INTERRUPT)
    },

    deleteMessage(payload: { dbId: number }): void {
      ipcRenderer.send(IPC_WORK.DELETE_MESSAGE, payload)
    },

    browserOpen(payload: WorkBrowserOpenPayload): void {
      ipcRenderer.send(IPC_WORK.BROWSER_OPEN, payload)
    },

    browserClose(id: string): void {
      ipcRenderer.send(IPC_WORK.BROWSER_CLOSE, id)
    },

    browserActivate(id: string | null): void {
      ipcRenderer.send(IPC_WORK.BROWSER_ACTIVATE, id)
    },

    browserAction(action: WorkBrowserAction): void {
      ipcRenderer.send(IPC_WORK.BROWSER_ACTION, action)
    },

    browserOverlay(open: boolean): void {
      ipcRenderer.send(IPC_WORK.BROWSER_OVERLAY, Boolean(open))
    },

    onBrowserState(cb: (state: WorkBrowserState) => void): () => void {
      const listener = (
        _event: Electron.IpcRendererEvent,
        state: WorkBrowserState
      ): void => cb(state)
      ipcRenderer.on(IPC_WORK.BROWSER_STATE, listener)
      return () => {
        ipcRenderer.removeListener(IPC_WORK.BROWSER_STATE, listener)
      }
    },

    onEvent(cb: (event: WorkMirrorEvent) => void): () => void {
      const listener = (_event: Electron.IpcRendererEvent, payload: WorkMirrorEvent): void =>
        cb(payload)
      ipcRenderer.on(IPC_WORK.EVENT, listener)
      return () => {
        ipcRenderer.removeListener(IPC_WORK.EVENT, listener)
      }
    },

    onPetReady(cb: () => void): () => void {
      const listener = (): void => cb()
      ipcRenderer.on(IPC_WORK.PET_READY, listener)
      return () => {
        ipcRenderer.removeListener(IPC_WORK.PET_READY, listener)
      }
    },

    reportEvent(event: WorkMirrorEvent): void {
      ipcRenderer.send(IPC_WORK.REPORT_EVENT, event)
    },

    onSendRequest(cb: (payload: WorkSendRequestPayload) => void): () => void {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: WorkSendRequestPayload
      ): void => cb(payload)
      ipcRenderer.on(IPC_WORK.SEND_REQUEST, listener)
      return () => {
        ipcRenderer.removeListener(IPC_WORK.SEND_REQUEST, listener)
      }
    },

    sendResult(payload: WorkSendResultPayload): void {
      ipcRenderer.send(IPC_WORK.SEND_RESULT, payload)
    },

    onHistoryRequest(cb: (payload: WorkHistoryRequestPayload) => void): () => void {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: WorkHistoryRequestPayload
      ): void => cb(payload)
      ipcRenderer.on(IPC_WORK.HISTORY_REQUEST, listener)
      return () => {
        ipcRenderer.removeListener(IPC_WORK.HISTORY_REQUEST, listener)
      }
    },

    reportHistory(payload: WorkHistoryPayload): void {
      ipcRenderer.send(IPC_WORK.HISTORY, payload)
    },

    onInterrupt(cb: () => void): () => void {
      const listener = (): void => cb()
      ipcRenderer.on(IPC_WORK.INTERRUPT, listener)
      return () => {
        ipcRenderer.removeListener(IPC_WORK.INTERRUPT, listener)
      }
    },

    onDeleteMessage(cb: (payload: { dbId: number }) => void): () => void {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: { dbId: number }
      ): void => cb(payload)
      ipcRenderer.on(IPC_WORK.DELETE_MESSAGE_REQUEST, listener)
      return () => {
        ipcRenderer.removeListener(IPC_WORK.DELETE_MESSAGE_REQUEST, listener)
      }
    },

    onPresence(cb: (payload: WorkPresencePayload) => void): () => void {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: WorkPresencePayload
      ): void => cb(payload)
      ipcRenderer.on(IPC_WORK.PRESENCE, listener)
      return () => {
        ipcRenderer.removeListener(IPC_WORK.PRESENCE, listener)
      }
    },

    getPresence(): Promise<WorkPresencePayload> {
      return ipcRenderer.invoke(IPC_WORK.GET_PRESENCE)
    }
  },

  /** 对话域：宠物面订阅"请求清空聊天"（气泡【清空】确认后主进程发出） */
  chat: {
    onClearRequested(cb: () => void): () => void {
      const listener = (): void => cb()
      ipcRenderer.on(IPC_EVENTS.CHAT_CLEAR_REQUESTED, listener)
      return () => {
        ipcRenderer.removeListener(IPC_EVENTS.CHAT_CLEAR_REQUESTED, listener)
      }
    }
  },

  app: {
    restart(): void {
      ipcRenderer.send(IPC.APP_RESTART)
    }
  },

  backend: {
    getSnapshot(): Promise<BackendSnapshot> {
      return ipcRenderer.invoke(IPC.BACKEND_GET_SNAPSHOT)
    },

    onStatusChanged(cb: (status: BackendStatusPayload) => void): () => void {
      const listener = (_event: Electron.IpcRendererEvent, status: BackendStatusPayload): void =>
        cb(status)
      ipcRenderer.on(IPC_EVENTS.BACKEND_STATUS_CHANGED, listener)
      return () => {
        ipcRenderer.removeListener(IPC_EVENTS.BACKEND_STATUS_CHANGED, listener)
      }
    },

    onReady(cb: (payload: BackendReadyPayload) => void): () => void {
      const listener = (_event: Electron.IpcRendererEvent, payload: BackendReadyPayload): void =>
        cb(payload)
      ipcRenderer.on(IPC_EVENTS.BACKEND_READY, listener)
      return () => {
        ipcRenderer.removeListener(IPC_EVENTS.BACKEND_READY, listener)
      }
    }
  }
}

contextBridge.exposeInMainWorld('pet', api)
