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
 * - 文件分析（P1/P2）：回形针选择 / 粘贴绝对路径 / 直接拖到兔子或窗口上 → 输入框上方
 *   并排显示附件 chip（× 可移除）。回车时按类型分流：纯图片仍进宠物会话（后端读图），
 *   任何 PDF/Office/文档都转任务模式（2026-10-25），宠物固定会话不再处理文件。
 */
import {
  useCallback,
  useEffect,
  useState,
  type ClipboardEvent,
  type ReactElement,
  type RefObject
} from 'react'
import type { PickedFile } from '../../../electron/ipc/channels'
import { getPetBridge } from '../../shared/pet-bridge'
import type { WsClient } from '../../shared/ws-client'
import { PET_SESSION_ID, type PetState } from '../../shared/protocol'
import { subscribeVoiceSpeaking, stopVoiceNow } from '../voice'
// 统一发送入口（P5 §7.5）：关键词（开始教学/下课）+ WS 发送 + 教学模式镜像/气泡都在此
import { sendUserMessage } from '../teaching'
import {
  isForegroundSession,
  setActiveConversationId
} from '../work/active-conversation'
import { notifyUserMessage } from './name-onboarding'
import { clearChatNotice, showChatNotice, subscribeChatNotice, type ChatNotice } from './notice'
import { speakLocalNotice } from './speech'
import {
  MAX_ATTACHMENTS,
  SUPPORTED_FILE_HINT,
  attachmentKindOf,
  filesBridge,
  looksLikeAbsolutePath,
  unsupportedReason
} from './file-support'

/** 去掉 IPC 包装后的可读错误（invoke reject 会带 "Error invoking remote method ..." 前缀） */
function ipcErrorText(err: unknown): string {
  const raw = (err as Error)?.message ?? String(err)
  return raw.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '')
}

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
  /** 本轮待发送附件（只存路径/文件名；正文由后端读取） */
  const [attachments, setAttachments] = useState<PickedFile[]>([])
  /** 正在把附件转成任务草稿（防连按 Enter 发两份） */
  const [drafting, setDrafting] = useState(false)
  /** 聊天区一次性提示（文件分析丢历史等） */
  const [notice, setNotice] = useState<ChatNotice | null>(null)
  /** 正有文件拖到窗口上（显示"松开添加"提示；透明区可能收不到事件，属平台限制） */
  const [dragActive, setDragActive] = useState(false)

  // 连接状态（决定输入是否可用）
  useEffect(() => client.onStateChange((s) => setConnected(s === 'connected')), [client])

  // 本地语音播放状态（voice 域独立订阅，不经 WS）
  useEffect(() => subscribeVoiceSpeaking(setVoiceSpeaking), [])

  // 一次性提示（notice 模块级单例：App 收到 WS notice 后写入，这里只负责展示）
  useEffect(() => subscribeChatNotice(setNotice), [])

  const addAttachments = useCallback((files: PickedFile[]): void => {
    setAttachments((prev) => {
      const next = [...prev]
      for (const file of files) {
        if (next.length >= MAX_ATTACHMENTS) break
        if (!next.some((item) => item.path === file.path)) next.push(file)
      }
      return next
    })
  }, [])

  const removeAttachment = useCallback((path: string): void => {
    setAttachments((prev) => prev.filter((item) => item.path !== path))
  }, [])

  /** 不支持的类型：上传时就拦住，由宠物短提示（5s）或聊天区 notice（5s）告知。 */
  const notifyUnsupportedFiles = useCallback((files: PickedFile[]): void => {
    if (files.length === 0) return
    const names = files
      .slice(0, 3)
      .map((file) => file.name)
      .join('、')
    const more = files.length > 3 ? ` 等 ${files.length} 个文件` : ''
    const detail =
      files.length === 1
        ? `「${files[0].name}」：${unsupportedReason(files[0]) ?? '这个类型我暂时看不了'}`
        : `有 ${files.length} 个文件我暂时看不了（${names}${more}）`
    const message = `${detail}～${SUPPORTED_FILE_HINT}`
    // 回复气泡活跃/常驻时不覆盖它，改用聊天区 notice；两者都是 5s 自动消失
    if (!speakLocalNotice(message, 5_000)) {
      showChatNotice(message, 'warn', 5_000)
    }
  }, [])

  /** 过滤掉不支持的类型，只返回可加入附件的文件。 */
  const acceptSupported = useCallback(
    (files: PickedFile[]): PickedFile[] => {
      const supported: PickedFile[] = []
      const unsupported: PickedFile[] = []
      for (const file of files) {
        if (unsupportedReason(file) === null) supported.push(file)
        else unsupported.push(file)
      }
      if (unsupported.length > 0) notifyUnsupportedFiles(unsupported)
      return supported
    },
    [notifyUnsupportedFiles]
  )

  /** 拖入的 File → 本地路径 → stat 校验 → 加进待发送附件（与回形针/粘贴共用同一列表）。 */
  const addDroppedFiles = useCallback(
    async (files: File[]): Promise<void> => {
      const bridge = filesBridge()
      if (!bridge?.pathFor || !bridge.stat) {
        showChatNotice('当前版本不支持拖入文件，请用回形针选择～', 'warn')
        return
      }
      // 一拖可能带进来几十个文件：先截断候选，避免一次触发大量 stat IPC
      const candidates = files.slice(0, MAX_ATTACHMENTS * 4)
      const paths = candidates
        .map((file) => bridge.pathFor?.(file) ?? '')
        .filter((path) => path.length > 0)
      if (paths.length === 0) {
        showChatNotice('没有识别到本地文件（网页里的图片/文件请先保存到本地）～', 'warn')
        return
      }
      const checked = await Promise.all(paths.map((path) => bridge.stat?.(path)))
      const picked = checked.filter((item): item is PickedFile => item !== null && item !== undefined)
      if (picked.length === 0) {
        showChatNotice('这些不是可读取的普通文件～', 'warn')
        return
      }
      const accepted = acceptSupported(picked)
      if (accepted.length === 0) return
      const room = MAX_ATTACHMENTS - attachments.length
      if (room <= 0) {
        showChatNotice(`一次最多带 ${MAX_ATTACHMENTS} 个文件～`, 'warn')
        return
      }
      if (accepted.length > room) {
        showChatNotice(`一次最多带 ${MAX_ATTACHMENTS} 个文件，先放前 ${room} 个～`, 'warn')
      }
      addAttachments(accepted.slice(0, room))
    },
    [acceptSupported, addAttachments, attachments.length]
  )

  // 文件拖拽：拖到兔子/窗口任意可接收区域 = 拖到输入框（松手后显示附件 chip）。
  // 透明穿透区由平台决定是否送事件；兔子实体区域是可接收的（与点击同一套命中逻辑）。
  useEffect(() => {
    if (hidden) return
    const hasFiles = (event: DragEvent): boolean =>
      Boolean(event.dataTransfer && Array.from(event.dataTransfer.types).includes('Files'))
    const onDragOver = (event: DragEvent): void => {
      if (!hasFiles(event)) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
      setDragActive(true)
    }
    const onDragLeave = (event: DragEvent): void => {
      if (event.relatedTarget === null) setDragActive(false)
    }
    const onDrop = (event: DragEvent): void => {
      if (!hasFiles(event)) return
      event.preventDefault()
      setDragActive(false)
      const files = Array.from(event.dataTransfer?.files ?? [])
      if (files.length > 0) void addDroppedFiles(files)
    }
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [addDroppedFiles, hidden])

  const handlePick = useCallback(async (): Promise<void> => {
    const bridge = filesBridge()
    if (!bridge?.pick) {
      showChatNotice('当前版本不支持选择文件，请重启应用后再试～', 'warn')
      return
    }
    try {
      const picked = await bridge.pick()
      if (picked.length === 0) return
      const accepted = acceptSupported(picked)
      if (accepted.length === 0) return
      const room = MAX_ATTACHMENTS - attachments.length
      if (room <= 0) {
        showChatNotice(`一次最多带 ${MAX_ATTACHMENTS} 个文件～`, 'warn')
        return
      }
      if (accepted.length > room) {
        showChatNotice(`一次最多带 ${MAX_ATTACHMENTS} 个文件，先放前 ${room} 个～`, 'warn')
      }
      addAttachments(accepted.slice(0, room))
    } catch (err) {
      console.error('[chat] 选择文件失败：', err)
      showChatNotice('打开文件选择框失败，请重试～', 'error')
    }
  }, [acceptSupported, addAttachments, attachments.length])

  /** 粘贴绝对路径 → 直接变成附件（是文件才拦截；不是文件则按普通文本粘贴）。 */
  const handlePaste = useCallback(
    async (event: ClipboardEvent<HTMLInputElement>): Promise<void> => {
      const raw = event.clipboardData.getData('text').trim()
      const bridge = filesBridge()
      if (!bridge?.stat || !looksLikeAbsolutePath(raw)) return
      event.preventDefault()
      try {
        const picked = await bridge.stat(raw)
        if (picked) {
          const accepted = acceptSupported([picked])
          if (accepted.length === 0) return
          if (attachments.length >= MAX_ATTACHMENTS) {
            showChatNotice(`一次最多带 ${MAX_ATTACHMENTS} 个文件～`, 'warn')
            return
          }
          addAttachments(accepted)
          showChatNotice(`已添加「${accepted[0].name}」`, 'info', 4_000)
        } else {
          // 不是文件（目录/不存在）：按普通文本补回输入框
          setInput((prev) => (prev ? `${prev}${raw}` : raw))
        }
      } catch {
        setInput((prev) => (prev ? `${prev}${raw}` : raw))
      }
    },
    [acceptSupported, addAttachments, attachments.length]
  )

  // 服务端事件订阅（chat 域只关心自己的事件，设计文档 §5.5 分发模式）
  useEffect(() => {
    // dev 态打印事件流（转发到主进程日志便于无 devtools 验证）；生产构建自动剔除
    const devLog = (msg: string): void => {
      if (import.meta.env.DEV) console.log(`[chat] ${msg}`)
    }
    const offs = [
      client.on('reply_start', ({ message_id, session_id }) => {
        if (!isForegroundSession(session_id)) return
        devLog(`reply_start ${message_id}`)
        setStreaming(true)
      }),
      client.on('reply_end', ({ message_id, full_text, interrupted, session_id }) => {
        if (!isForegroundSession(session_id)) return
        devLog(`reply_end full_text(${full_text.length}字) interrupted=${Boolean(interrupted)}`)
        setStreaming(false)
      }),
      // 宠物状态机（speaking/thinking 决定"停止"按钮是否显示）
      client.on('state', ({ state, session_id }) => {
        if (!isForegroundSession(session_id)) return
        setPetState(state)
      })
    ]
    return () => offs.forEach((off) => off())
  }, [client])

  const handleSend = useCallback(async (): Promise<void> => {
    if (drafting) return
    const text = input.trim()
    if (!text && attachments.length === 0) return

    // 文档/代码/PDF 等非图片附件：不进宠物会话，一律转任务模式（纯图片仍由宠物直接看）
    const hasDocument = attachments.some((file) => attachmentKindOf(file) !== 'image')
    if (hasDocument) {
      let agent: ReturnType<typeof getPetBridge>['agent'] | undefined
      try {
        agent = getPetBridge().agent
      } catch {
        agent = undefined
      }
      if (!agent?.draftTask) {
        showChatNotice('当前版本不支持任务模式，请重启应用后再试～', 'warn')
        return
      }
      setDrafting(true)
      try {
        const result = await agent.draftTask({
          text,
          attachments: attachments.map((file) => ({
            path: file.path,
            name: file.name,
            kind: attachmentKindOf(file)
          }))
        })
        if (!result.ok) {
          showChatNotice(result.error ?? '转到任务模式失败，请重试～', 'error')
          return
        }
        setInput('')
        setAttachments([])
        clearChatNotice()
        showChatNotice('已转到任务模式处理', 'info', 4_000)
      } catch (err) {
        showChatNotice(ipcErrorText(err) || '转到任务模式失败，请重试～', 'error')
      } finally {
        setDrafting(false)
      }
      return
    }

    // 只选图片没打字：给一个默认分析请求（后端也允许空问题，这里保证气泡/黑板有可读文本）
    const question = text || '帮我看看这个文件'
    // 从宠物窗口发言：切到固定的宠物会话，并同步前台（气泡/语音跟它走）
    setActiveConversationId(PET_SESSION_ID)
    client.send('conversation_focus', { session_id: PET_SESSION_ID })
    // 统一发送入口（teaching 域）：关键词（开始教学/下课）→ WS 发送 → 教学模式镜像 + 头顶气泡
    if (!sendUserMessage(client, question, attachments, null, PET_SESSION_ID)) return
    // 启动称呼引导（chat 域）：记录"用户已发言"；提问后的回答窗口据此判定拒绝/已回应
    notifyUserMessage(question)
    setInput('')
    setAttachments([])
    clearChatNotice()
  }, [attachments, client, drafting, input])

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
      {/* 拖拽提示：文件拖到兔子/窗口上时出现，松手后变成附件 chip */}
      {dragActive ? (
        <div className="chat-drop-hint" data-testid="chat-drop-hint">
          松开鼠标：图片直接在聊天看，文档会转到任务模式
        </div>
      ) : null}

      {/* 一次性提示（文件分析丢历史等）：显示在附件/输入行上方，自动消失 */}
      {notice ? (
        <div className={`chat-notice chat-notice-${notice.kind}`} role="status" data-testid="chat-notice">
          {notice.text}
        </div>
      ) : null}

      {/* 待发送附件：文件名 + 移除按钮（正文不经过渲染进程） */}
      {attachments.length > 0 ? (
        <div className="chat-attachments" data-testid="chat-attachments">
          {attachments.map((file) => (
            <span className="chat-attachment-chip" key={file.path} title={file.path}>
              <span className="chat-attachment-name">{file.name}</span>
              <button
                className="chat-attachment-remove"
                type="button"
                aria-label={`移除 ${file.name}`}
                onClick={() => removeAttachment(file.path)}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}

      <div className="chat-input-row">
        <button
          className="chat-attach"
          data-testid="chat-attach"
          type="button"
          onClick={handlePick}
          disabled={!connected || attachments.length >= MAX_ATTACHMENTS}
          title={connected ? '发送文件 / 图片' : '等待后端连接…'}
          aria-label="发送文件"
        >
          <PaperclipIcon />
        </button>
        <input
          className="chat-input"
          data-testid="chat-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onPaste={handlePaste}
          onKeyDown={(e) => {
            // IME 组合期间的 Enter 属于候选词确认，不触发发送
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault()
              handleSend()
            }
          }}
          placeholder={
            !connected
              ? '等待后端连接…'
              : drafting
                ? '正在转到任务模式…'
                : attachments.some((file) => attachmentKindOf(file) !== 'image')
                  ? '发送后转到任务模式处理…'
                  : attachments.length > 0
                    ? '说说想让我看什么…'
                    : '说点什么…'
          }
          title={connected ? '按 Enter 发送；可粘贴文件路径' : undefined}
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
            disabled={
            !connected || drafting || (input.trim().length === 0 && attachments.length === 0)
          }
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

/** 附件：回形针 */
function PaperclipIcon(): ReactElement {
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
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  )
}

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
