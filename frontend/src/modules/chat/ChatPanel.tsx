/**
 * 对话域（设计文档 §5.4）：输入框 + 打断按钮。
 *
 * 消息列表已去掉（2026-10-16 用户定稿"回复以气泡形式出现在兔子头部旁"）：
 * 聊天回复改由**说话气泡**展示（驱动在同域 speech.ts，气泡窗归 electron/bubble 域），
 * 本组件只留输入行——错误提示/回复文本都不再在这里渲染。
 *
 * - Enter 发送 user_message（IME 组合中不误发）；
 * - streaming 本地标志（reply_start/reply_end）驱动"停止"按钮的兜底显示；
 * - "停止"按钮（P2 §7.2 打断）：思考中/说话中显示 → 发 interrupt + 本地立即停播（voice 域）；
 * - 输入行是紧凑胶囊（250×32，居中贴兔子脚）：默认半透明、hover/focus 不透明；
 *   发送/停止共用右侧圆钮槽位（忙碌切换不抖宽度），发送改为图标（2026-10-17 用户定稿）。
 */
import { useCallback, useEffect, useState, type ReactElement, type RefObject } from 'react'
import type { WsClient } from '../../shared/ws-client'
import type { PetState } from '../../shared/protocol'
import { subscribeVoiceSpeaking, stopVoiceNow } from '../voice'
// 统一发送入口（P5 §7.5）：关键词（开始教学/下课）+ WS 发送 + 教学模式镜像/气泡都在此
import { sendUserMessage } from '../teaching'

interface ChatPanelProps {
  client: WsClient
  /** App 侧用于把聊天面板纳入窗口可交互矩形（X11 形状穿透） */
  containerRef?: RefObject<HTMLDivElement>
  /**
   * 教学模式展开态收起（P5 §7.5：内容都在黑板上）。
   * display:none 收起、组件保留挂载——输入状态不丢，折叠让路或退出教学即原样恢复。
   */
  hidden?: boolean
}

export default function ChatPanel({ client, containerRef, hidden = false }: ChatPanelProps): ReactElement {
  const [input, setInput] = useState('')
  const [connected, setConnected] = useState(client.connectionState === 'connected')
  /** 宠物状态机（"停止"按钮显示依据：speaking/thinking） */
  const [petState, setPetState] = useState<PetState>('idle')
  /** 本地语音是否在播（voice 域，§4.4） */
  const [voiceSpeaking, setVoiceSpeaking] = useState(false)
  /** 本轮回复流式接收中（reply_start → reply_end；"停止"按钮兜底显示用） */
  const [streaming, setStreaming] = useState(false)

  // 连接状态（决定输入是否可用）
  useEffect(() => client.onStateChange((s) => setConnected(s === 'connected')), [client])

  // 本地语音播放状态（voice 域独立订阅，不经 WS）
  useEffect(() => subscribeVoiceSpeaking(setVoiceSpeaking), [])

  // 服务端事件订阅（chat 域只关心自己的事件，设计文档 §5.5 分发模式）
  useEffect(() => {
    // dev 态打印事件流（转发到主进程日志便于无 devtools 验证）；生产构建自动剔除
    const devLog = (msg: string): void => {
      if (import.meta.env.DEV) console.log(`[chat] ${msg}`)
    }
    const offs = [
      client.on('reply_start', ({ message_id }) => {
        devLog(`reply_start ${message_id}`)
        setStreaming(true)
      }),
      client.on('reply_end', ({ message_id, full_text, interrupted }) => {
        devLog(`reply_end full_text(${full_text.length}字) interrupted=${Boolean(interrupted)}`)
        setStreaming(false)
      }),
      // 宠物状态机（speaking/thinking 决定"停止"按钮是否显示）
      client.on('state', ({ state }) => setPetState(state))
    ]
    return () => offs.forEach((off) => off())
  }, [client])

  const handleSend = useCallback((): void => {
    const text = input.trim()
    if (!text) return
    // 统一发送入口（teaching 域）：关键词（开始教学/下课）→ WS 发送 → 教学模式镜像 + 头顶气泡
    if (!sendUserMessage(client, text)) return
    setInput('')
  }, [client, input])

  /**
   * 打断（§7.2）：发 interrupt 通知后端取消 LLM 流 + TTS 队列；
   * 本地立即停播静音（不等 reply_end 回声；后端回 reply_end{interrupted} 时会再清一次，幂等）。
   * 说话气泡随 reply_end(interrupted) 由 speech.ts 立即收起。
   */
  const handleStop = useCallback((): void => {
    const sent = client.send('interrupt', {})
    stopVoiceNow('点击停止按钮')
    if (import.meta.env.DEV) console.log(`[chat] interrupt 已发（sent=${sent}），本地语音已停`)
  }, [client])

  // "停止"按钮显示条件：后端状态说话中/思考中；或本地兜底（回复流式中 / 语音在播）——
  // state 事件滞后（打断后本地已静音但后端尚未回 idle）时按钮仍可用
  const busy = petState === 'speaking' || petState === 'thinking' || voiceSpeaking || streaming

  return (
    <div
      className={`chat-panel${hidden ? ' chat-panel-hidden' : ''}`}
      ref={containerRef}
      data-testid="chat-panel"
    >
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
          placeholder={connected ? '说点什么…' : '等待后端连接…'}
          title={connected ? '按 Enter 发送' : undefined}
          aria-label="聊天输入"
          disabled={!connected}
        />
        {/* 发送/停止共用一个槽位：窄胶囊里不并排塞两个按钮（宽度恒定，不抖动）。
            忙碌时点停止 = 打断；Enter 发送仍可用（输入框不禁用）。 */}
        {busy ? (
          <button
            className="chat-stop"
            data-testid="chat-stop"
            type="button"
            onClick={handleStop}
            title="打断当前回复（停止说话/思考）"
            aria-label="停止"
          >
            <StopIcon />
          </button>
        ) : (
          <button
            className="chat-send"
            data-testid="chat-send"
            type="button"
            onClick={handleSend}
            disabled={!connected || input.trim().length === 0}
            title="发送（Enter）"
            aria-label="发送"
          >
            <SendIcon />
          </button>
        )}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ 图标（线稿，currentColor）

/** 发送：纸飞机 */
function SendIcon(): ReactElement {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M22 2 11 13" />
      <path d="M22 2 15 22l-4-9-9-4 20-7Z" />
    </svg>
  )
}

/** 停止：圆角方块 */
function StopIcon(): ReactElement {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="6" y="6" width="12" height="12" rx="2.5" />
    </svg>
  )
}
