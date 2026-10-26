/**
 * 对话发送与打断（2026-10-26 从 WorkApp 抽出）。
 *
 * 负责：发送前校验（bridge 可用、当前对话未在回复）、附件透传、失败提示；
 * 打断当前对话。只发请求，消息渲染由镜像事件回填。
 */
import { useCallback } from 'react'
import type { PickedFile } from '../../../../electron/ipc/channels'
import type { WorkAction } from '../../store'
import { reasonText } from '../format'
import { makeRequestId } from '../../request-id'
import { workBridge } from '../../work-bridge'

export interface WorkSendOptions {
  /** 联网搜索开关 */
  search: boolean
  /** 正在回复的会话集合（同一对话不允许并发发送） */
  streamingIdsRef: React.MutableRefObject<Set<string>>
  activeConversationRef: React.MutableRefObject<string>
  dispatch: React.Dispatch<WorkAction>
  /** 发送成功后恢复滚动跟随 */
  stickToBottom: () => void
}

export interface WorkSendControls {
  handleSend: (text: string, files: PickedFile[]) => Promise<boolean>
  handleInterrupt: () => void
}

export function useWorkSend({
  search,
  streamingIdsRef,
  activeConversationRef,
  dispatch,
  stickToBottom
}: WorkSendOptions): WorkSendControls {
  const handleSend = useCallback(
    async (text: string, files: PickedFile[]): Promise<boolean> => {
      const api = workBridge()
      if (!api?.requestSend) {
        dispatch({
          type: 'mirror',
          event: {
            kind: 'notice',
            code: 'work_unavailable',
            message: '当前版本不支持工作模式，请重启应用后再试～',
            level: 'warn'
          }
        })
        return false
      }
      if (streamingIdsRef.current.has(activeConversationRef.current)) {
        dispatch({
          type: 'mirror',
          event: {
            kind: 'notice',
            code: 'busy_conversation',
            message: '这个对话正在回复中，等它结束后再发～',
            level: 'warn'
          }
        })
        return false
      }
      const attachments = files.map((file) => ({ path: file.path, name: file.name }))
      try {
        const result = await api.requestSend({
          requestId: makeRequestId(),
          text,
          attachments,
          options: { search },
          sessionId: activeConversationRef.current || undefined
        })
        if (!result.ok) {
          dispatch({
            type: 'mirror',
            event: {
              kind: 'notice',
              code: 'send_failed',
              message: reasonText(result.reason),
              level: 'warn'
            }
          })
          return false
        }
        stickToBottom()
        return true
      } catch (err) {
        console.warn('[work] 发送失败：', err)
        dispatch({
          type: 'mirror',
          event: {
            kind: 'notice',
            code: 'send_failed',
            message: reasonText(),
            level: 'warn'
          }
        })
        return false
      }
    },
    [activeConversationRef, dispatch, search, stickToBottom, streamingIdsRef]
  )

  const handleInterrupt = useCallback((): void => {
    workBridge()?.interrupt(activeConversationRef.current || undefined)
  }, [activeConversationRef])

  return { handleSend, handleInterrupt }
}
