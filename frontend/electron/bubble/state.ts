/** 气泡域跨模块共享的状态（窗口/定位/说话/菜单都要读写的少量字段）。 */
import type { BrowserWindow } from 'electron'
import type { BubbleOpenPayload } from '../ipc/channels'

/**
 * 当前待确认动作（2026-10-18 泛化）：确认气泡不再只服务"清空聊天"。
 * - ``onConfirm``：用户点「确认」后执行的动作（清空聊天 / 删除文件的 IPC 回调等）；
 * - ``resolve``：把"确认/取消/超时/点别处"的结果交还给请求方（invoke 的 Promise）；
 * - ``timer``：长时间无操作按取消处理，避免调用方永久挂起。
 */
export interface PendingConfirm {
  onConfirm: () => void | Promise<void>
  resolve: (confirmed: boolean) => void
  timer: NodeJS.Timeout | null
}

export const bubbleState: {
  /** 宠物窗口（initBubble 注入） */
  petWin: BrowserWindow | null
  /** 弹出流程防重入（等待页面就绪是异步的） */
  opening: boolean
  /** 收起流程中（已发 REQUEST_CLOSE、等待渲染侧退场回报或超时兜底） */
  closing: boolean
  /** 弹出会话序号（每次 OPEN 递增；渲染侧按 session 去重） */
  sessionSeq: number
  /** 当前内容载荷（动作白名单校验 / 补发 / tail 更新用） */
  currentPayload: BubbleOpenPayload | null
  /** 当前是否交互态（菜单/确认态 true；说话气泡纯展示态 false） */
  interactive: boolean
  /** 当前待确认动作 */
  pendingConfirm: PendingConfirm | null
  /** 说话气泡右键菜单打开中：原生菜单可能让窗失焦，blur 守卫必须放行 */
  speechContextMenuOpen: boolean
} = {
  petWin: null,
  opening: false,
  closing: false,
  sessionSeq: 0,
  currentPayload: null,
  interactive: true,
  pendingConfirm: null,
  speechContextMenuOpen: false
}

/** 应用退出/窗口销毁后的共享状态复位 */
export function resetSharedState(): void {
  bubbleState.petWin = null
  bubbleState.opening = false
  bubbleState.closing = false
  bubbleState.currentPayload = null
  bubbleState.interactive = true
  bubbleState.pendingConfirm = null
  bubbleState.speechContextMenuOpen = false
}
