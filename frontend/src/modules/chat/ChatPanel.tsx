/**
 * 对话域（设计文档 §5.4）：输入框 + 消息气泡。
 *
 * - Enter 发送 user_message（IME 组合中不误发）；
 * - 助手气泡订阅 reply_start / token / reply_end：逐字渲染 → full_text 定型；
 * - emotion 事件挂到对应助手气泡（emoji 占位，Live2D 未接）；
 * - error 事件以气泡形式展示，不崩溃。
 */
import { useCallback, useEffect, useRef, useState, type ReactElement, type RefObject } from 'react'
import type { WsClient } from '../../shared/ws-client'
import { emotionEmoji } from './emotions'

/** 一条聊天消息（用户 / 助手 / 错误提示） */
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  /** 助手气泡：是否仍在流式接收 token */
  streaming: boolean
  /** 助手气泡：当前情绪（emotion 事件驱动） */
  emotion?: string
  /** 助手气泡：被中断（reply_end.interrupted） */
  interrupted?: boolean
  /** 错误提示气泡 */
  isError?: boolean
}

interface ChatPanelProps {
  client: WsClient
  /** App 侧用于把聊天面板纳入窗口可交互矩形（X11 形状穿透） */
  containerRef?: RefObject<HTMLDivElement>
}

/** 往消息列表插入 / 更新一条助手消息（token 早于 reply_start 时的兜底） */
function upsertAssistant(
  list: ChatMessage[],
  id: string,
  update: (m: ChatMessage) => ChatMessage
): ChatMessage[] {
  const idx = list.findIndex((m) => m.id === id)
  if (idx === -1) {
    return [...list, update({ id, role: 'assistant', text: '', streaming: true })]
  }
  const next = [...list]
  next[idx] = update(next[idx])
  return next
}

export default function ChatPanel({ client, containerRef }: ChatPanelProps): ReactElement {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [connected, setConnected] = useState(client.connectionState === 'connected')
  const listRef = useRef<HTMLDivElement | null>(null)
  const localSeqRef = useRef(0)

  // 连接状态（决定输入是否可用）
  useEffect(() => client.onStateChange((s) => setConnected(s === 'connected')), [client])

  // 服务端事件订阅（chat 域只关心自己的事件，设计文档 §5.5 分发模式）
  useEffect(() => {
    // dev 态打印事件流（转发到主进程日志便于无 devtools 验证）；生产构建自动剔除
    const devLog = (msg: string): void => {
      if (import.meta.env.DEV) console.log(`[chat] ${msg}`)
    }
    const offs = [
      client.on('reply_start', ({ message_id }) => {
        devLog(`reply_start ${message_id}`)
        setMessages((ms) => upsertAssistant(ms, message_id, (m) => ({ ...m, streaming: true })))
      }),
      client.on('token', ({ message_id, text }) => {
        devLog(`token ${JSON.stringify(text)}`)
        setMessages((ms) =>
          upsertAssistant(ms, message_id, (m) => ({ ...m, text: m.text + text, streaming: true }))
        )
      }),
      client.on('reply_end', ({ message_id, full_text, interrupted }) => {
        devLog(`reply_end full_text(${full_text.length}字) interrupted=${Boolean(interrupted)}`)
        setMessages((ms) =>
          ms.map((m) =>
            m.id === message_id
              ? {
                  ...m,
                  // full_text 是后端权威终稿；为空时保留 token 累积结果
                  text: full_text || m.text,
                  streaming: false,
                  interrupted: Boolean(interrupted)
                }
              : m
          )
        )
      }),
      client.on('emotion', ({ message_id, emotion }) => {
        devLog(`emotion -> ${emotion}（${message_id}）`)
        setMessages((ms) => ms.map((m) => (m.id === message_id ? { ...m, emotion } : m)))
      }),
      client.on('error', ({ code, message }) => {
        console.error(`[chat] error 事件：${code} ${message}`)
        localSeqRef.current += 1
        setMessages((ms) => [
          ...ms,
          {
            id: `err_${localSeqRef.current}`,
            role: 'assistant',
            text: `⚠ ${code}: ${message}`,
            streaming: false,
            isError: true
          }
        ])
      })
    ]
    return () => offs.forEach((off) => off())
  }, [client])

  // 自动滚动到底部
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  const handleSend = useCallback((): void => {
    const text = input.trim()
    if (!text) return
    if (!client.send('user_message', { text })) return
    localSeqRef.current += 1
    setMessages((ms) => [
      ...ms,
      { id: `local_${localSeqRef.current}`, role: 'user', text, streaming: false }
    ])
    setInput('')
  }, [client, input])

  return (
    <div className="chat-panel" ref={containerRef} data-testid="chat-panel">
      <div className="chat-messages" ref={listRef} data-testid="chat-messages">
        {messages.map((m) => (
          <div
            key={m.id}
            className={`chat-bubble ${m.role}${m.isError ? ' error' : ''}${
              m.streaming ? ' streaming' : ''
            }`}
          >
            {m.emotion && (
              <span className="chat-bubble-emotion" title={`emotion: ${m.emotion}`}>
                {emotionEmoji(m.emotion)}
              </span>
            )}
            <span className="chat-bubble-text">{m.text}</span>
            {m.streaming && <span className="chat-caret">▍</span>}
            {m.interrupted && <span className="chat-interrupted">（已打断）</span>}
          </div>
        ))}
      </div>
      <div className="chat-input-row">
        <input
          className="chat-input"
          data-testid="chat-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // IME 组合期间的 Enter 属于候选词确认，不触发发送
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault()
              handleSend()
            }
          }}
          placeholder={connected ? '说点什么…（Enter 发送）' : '等待后端连接…'}
          disabled={!connected}
        />
        <button
          className="chat-send"
          data-testid="chat-send"
          onClick={handleSend}
          disabled={!connected || input.trim().length === 0}
        >
          发送
        </button>
      </div>
    </div>
  )
}
