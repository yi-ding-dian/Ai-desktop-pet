/**
 * preload：contextBridge 安全桥（只暴露白名单 API，设计文档 §2.2）。
 * 渲染进程只能访问 window.pet，无法触达 Node / Electron 原生能力。
 */
import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC,
  IPC_EVENTS,
  IPC_FX,
  type BackendReadyPayload,
  type BackendSnapshot,
  type BackendStatusPayload,
  type FxCommand,
  type FxPetReactionPayload,
  type PetBridgeApi,
  type SettingsVisibilityPayload,
  type TeachingBoardInbox,
  type TeachingEnterReason,
  type TeachingMirrorEvent,
  type TeachingStatePayload,
  type TrayMenuAction,
  type WindowDebugState
} from './ipc/channels'
import type { MoveResult, Point, Rect, WindowGeometry } from './window'

const api: PetBridgeApi = {
  platform: process.platform,

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

  fx: {
    ready(): void {
      ipcRenderer.send(IPC_FX.READY)
    },

    onCommand(cb: (cmd: FxCommand) => void): () => void {
      const listener = (_event: Electron.IpcRendererEvent, cmd: FxCommand): void => cb(cmd)
      ipcRenderer.on(IPC_FX.COMMAND, listener)
      return () => {
        ipcRenderer.removeListener(IPC_FX.COMMAND, listener)
      }
    },

    onPetReaction(cb: (payload: FxPetReactionPayload) => void): () => void {
      const listener = (_event: Electron.IpcRendererEvent, payload: FxPetReactionPayload): void =>
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
