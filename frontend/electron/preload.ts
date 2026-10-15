/**
 * preload：contextBridge 安全桥（只暴露白名单 API，设计文档 §2.2）。
 * 渲染进程只能访问 window.pet，无法触达 Node / Electron 原生能力。
 */
import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC,
  IPC_EVENTS,
  type BackendReadyPayload,
  type BackendSnapshot,
  type BackendStatusPayload,
  type PetBridgeApi,
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
    }
  },

  system: {
    getIdleSeconds(): Promise<number> {
      return ipcRenderer.invoke(IPC.SYSTEM_GET_IDLE_SECONDS)
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
