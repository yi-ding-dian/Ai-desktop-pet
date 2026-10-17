/**
 * preload：contextBridge 安全桥（只暴露白名单 API，设计文档 §2.2）。
 * 渲染进程只能访问 window.pet，无法触达 Node / Electron 原生能力。
 */
import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC,
  IPC_BUBBLE,
  IPC_EVENTS,
  IPC_BALL_ANIMATION,
  type BackendReadyPayload,
  type BackendSnapshot,
  type BackendStatusPayload,
  type BubbleOpenPayload,
  type BubbleRequest,
  type BubbleTail,
  type BubbleUpdatePayload,
  type BallAnimationCommand,
  type BallAnimationPetReactionPayload,
  type PetBridgeApi,
  type SettingsVisibilityPayload,
  type TeachingBoardInbox,
  type TeachingEnterReason,
  type TeachingMirrorEvent,
  type TeachingStatePayload,
  type TrayMenuAction,
  type WindowDebugState
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

    onGeometryChanged(cb: (geo: WindowGeometry) => void): () => void {
      const listener = (_event: Electron.IpcRendererEvent, geo: WindowGeometry): void => cb(geo)
      ipcRenderer.on(IPC_EVENTS.WINDOW_GEOMETRY_CHANGED, listener)
      return () => {
        ipcRenderer.removeListener(IPC_EVENTS.WINDOW_GEOMETRY_CHANGED, listener)
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

  system: {
    getIdleSeconds(): Promise<number> {
      return ipcRenderer.invoke(IPC.SYSTEM_GET_IDLE_SECONDS)
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

    requestSend(text: string): void {
      ipcRenderer.send(IPC.TEACHING_REQUEST_SEND, text)
    },

    resizeBoard(width: number): void {
      ipcRenderer.send(IPC.TEACHING_BOARD_RESIZE, width)
    },

    onSendRequest(cb: (payload: { text: string }) => void): () => void {
      const listener = (_event: Electron.IpcRendererEvent, payload: { text: string }): void =>
        cb(payload)
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

    sayBegin(): void {
      ipcRenderer.send(IPC_BUBBLE.SAY_BEGIN)
    },

    sayText(text: string): void {
      ipcRenderer.send(IPC_BUBBLE.SAY_TEXT, { text })
    },

    sayEnd(immediate = false): void {
      ipcRenderer.send(IPC_BUBBLE.SAY_END, { immediate })
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
