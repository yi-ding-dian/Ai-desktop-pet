/**
 * preload：contextBridge 安全桥（只暴露白名单 API，设计文档 §2.2）。
 * 渲染进程只能访问 window.pet，无法触达 Node / Electron 原生能力。
 */
import { contextBridge, ipcRenderer } from 'electron'
import { IPC, IPC_EVENTS, type PetBridgeApi, type WindowDebugState } from './ipc/channels'
import type { Point, Rect } from './window'

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
    }
  }
}

contextBridge.exposeInMainWorld('pet', api)
