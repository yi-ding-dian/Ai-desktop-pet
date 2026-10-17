/**
 * 黑板面应用（board.html → src/board/main.tsx → 本组件）——教学模式"哑显示"端。
 *
 * 定位（设计文档 §7.5.2）：对话主体仍在宠物窗口的 WS 连接上，宠物面把
 * user_message / reply_start / token / reply_end / history 镜像给主进程，
 * 主进程经 `teaching:board-inbox` 路由到本页（mirror / goto / visibility 三类指令）；
 * 黑板输入条反向走 `requestSend` → 主进程 → 宠物面执行 WS 发送。本页不连 WS。
 *
 * 容错（重要）：teaching 段由主进程侧并行落地，运行时可能尚不存在——
 * 所有 bridge 调用一律可选链，缺失时静默跳过 + console.warn 一次
 * （先例：modules/pet/PetView.tsx 的 `ballAnimation?.onPetReaction?.`）。
 *
 * 视图两态：
 *  - 展开态 = 主视图（顶栏 / 滚动板书区 / 底部输入条；板体深色半透明圆角 20）；
 *  - 折叠态 = 24×140 角标（贴满窗口的小竖条，点击 requestUnfold 恢复）。
 * 折叠 ≠ 下课：折叠前记录滚动锚点，展开且内容未变时原位恢复。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import { getPetBridge } from '../shared/pet-bridge'
import type { PetBridgeApi, TeachingBoardInbox, TeachingMirrorEvent } from '../../electron/ipc/channels'
import { renderMarkdownSafe } from './markdown'

// ------------------------------------------------------------------ bridge 容错访问

/** 告警去重（同一 key 只 warn 一次，避免流式期间刷屏） */
const warned = new Set<string>()
function warnOnce(key: string, ...args: unknown[]): void {
  if (warned.has(key)) return
  warned.add(key)
  console.warn('[board]', ...args)
}

/** 取 teaching 段；preload 未注入 / 段缺失时返回 undefined（静默降级 + 告警一次） */
function teaching(): PetBridgeApi['teaching'] | undefined {
  try {
    const bridge = getPetBridge()
    if (!bridge?.teaching) {
      warnOnce('teaching-missing', 'preload 尚无 teaching 段（主进程侧未就绪），黑板进入离线只读态')
      return undefined
    }
    return bridge.teaching
  } catch (err) {
    warnOnce('bridge-missing', 'pet-bridge 不可用：', err)
    return undefined
  }
}

// ------------------------------------------------------------------ 消息模型

/** 问题卡（mirror.user_message / history 中 role=user） */
interface QuestionItem {
  kind: 'question'
  /** 黑板本地稳定 key（DOM data-key，goto 按它定位） */
  key: string
  /** goto(messageId) 可命中的全部别名（history 的 user id / 未来的 localId / 本地 key） */
  aliases: string[]
  text: string
}

/** 讲解卡（reply_start 先占位；token 渐进渲染；reply_end 终态用同一渲染函数收口） */
interface ReplyItem {
  kind: 'reply'
  key: string
  messageId: string
  /** 流式阶段累计文本（每次 token 到达即整块重渲染——渐进 Markdown，半围栏由渲染层补合） */
  streamText: string
  /** reply_end 后的全文（终态渲染源；null = 尚未结束） */
  finalText: string | null
  interrupted: boolean
  done: boolean
}

type BoardItem = QuestionItem | ReplyItem

/** 就地 upsert 讲解卡（reply_start 建卡 / token 追加 / reply_end 收尾共用；同 messageId 只一张） */
function upsertReply(
  prev: BoardItem[],
  messageId: string,
  mutate: (r: ReplyItem) => ReplyItem
): BoardItem[] {
  const idx = prev.findIndex((it) => it.kind === 'reply' && it.messageId === messageId)
  if (idx >= 0) {
    const next = prev.slice()
    next[idx] = mutate(next[idx] as ReplyItem)
    return next
  }
  const fresh: ReplyItem = {
    kind: 'reply',
    key: `r-${messageId}`,
    messageId,
    streamText: '',
    finalText: null,
    interrupted: false,
    done: false
  }
  return [...prev, mutate(fresh)]
}

// ------------------------------------------------------------------ 组件

export default function BoardApp(): JSX.Element {
  const [folded, setFolded] = useState(false)
  const [items, setItems] = useState<BoardItem[]>([])
  const [draft, setDraft] = useState('')

  // ---- refs：事件回调（订阅一次）与渲染解耦，全部经 refs 读写
  const foldedRef = useRef(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  /** 折叠前记录的滚动锚点（top + 当时 scrollHeight，用于"内容未变时原位恢复"） */
  const anchorRef = useRef<{ top: number; height: number } | null>(null)
  /** 折叠期间收到的 goto：展开后补执行 */
  const pendingGoto = useRef<string | null>(null)
  /** 用户是否贴着底部（决定流式时是否跟随滚动） */
  const nearBottomRef = useRef(true)
  /** 本地问题卡序号 */
  const qSeq = useRef(0)
  /** goto 解析：别名 → 问题卡 key */
  const aliasToKey = useRef(new Map<string, string>())
  /** goto 解析：讲解卡 messageId → 其之前最近的问题卡 key（无则 null） */
  const replyToQuestion = useRef(new Map<string, string | null>())
  /** 最近一张问题卡 key（讲解卡回指用） */
  const lastQuestionKey = useRef<string | null>(null)

  const applyFolded = (v: boolean): void => {
    foldedRef.current = v
    setFolded(v)
  }

  // ---- 滚动工具

  const updateNearBottom = (): void => {
    const el = scrollRef.current
    if (!el) return
    nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64
  }

  /** 解析 goto(messageId)：① 直接命中问题卡别名；② 命中讲解卡 → 回指其问题卡（"跳到该问题的讲解段落"） */
  const resolveGotoKey = (messageId: string): string | null => {
    const byAlias = aliasToKey.current.get(messageId)
    if (byAlias) return byAlias
    if (replyToQuestion.current.has(messageId)) {
      return replyToQuestion.current.get(messageId) ?? `r-${messageId}`
    }
    return null
  }

  /** 跳转 + 600ms 高亮闪烁（数据流：主进程 goto → 本函数） */
  const flashTo = (key: string): void => {
    const host = scrollRef.current
    if (!host) return
    const el = host.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)
    if (!el) {
      warnOnce(`goto-miss:${key}`, `跳转目标不在板面（消息可能早于窗口重建）：${key}`)
      return
    }
    el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    el.classList.remove('goto-flash')
    void el.offsetWidth // 强制重排以重启 CSS 动画（连续 goto 同一目标也可闪）
    el.classList.add('goto-flash')
    window.setTimeout(() => el.classList.remove('goto-flash'), 700)
  }

  const handleGoto = (messageId: string): void => {
    if (foldedRef.current) {
      // 折叠态：先记下，展开后再闪（展开由主进程 visibility expand 驱动）
      pendingGoto.current = messageId
      return
    }
    const key = resolveGotoKey(messageId)
    if (key) flashTo(key)
    else warnOnce(`goto-unknown:${messageId}`, `goto 的 messageId 无法匹配任何卡片：${messageId}`)
  }

  // ---- mirror 事件应用（本地 state 为镜像；黑板不产生对话）

  const applyMirror = (event: TeachingMirrorEvent): void => {
    switch (event.kind) {
      case 'user_message': {
        const key = `q-${++qSeq.current}`
        const aliases = [key]
        // 宽松读取：当前契约 user_message 不含 id；若将来携带 localId/id，登记为别名供 goto 命中
        const loose = event as unknown as { localId?: unknown; id?: unknown }
        for (const v of [loose.localId, loose.id]) {
          if (typeof v === 'string' && v) aliases.push(v)
        }
        for (const a of aliases) aliasToKey.current.set(a, key)
        lastQuestionKey.current = key
        const text = event.text
        setItems((prev) => [...prev, { kind: 'question', key, aliases, text }])
        break
      }
      case 'reply_start': {
        replyToQuestion.current.set(event.messageId, lastQuestionKey.current)
        const { messageId } = event
        setItems((prev) => upsertReply(prev, messageId, (r) => r))
        break
      }
      case 'token': {
        const { messageId, text } = event
        setItems((prev) => upsertReply(prev, messageId, (r) => ({ ...r, streamText: r.streamText + text })))
        break
      }
      case 'reply_end': {
        const { messageId, fullText, interrupted } = event
        setItems((prev) =>
          upsertReply(prev, messageId, (r) => ({
            ...r,
            done: true,
            finalText: fullText,
            interrupted: Boolean(interrupted)
          }))
        )
        break
      }
      case 'history': {
        // 快照语义（主进程 ready 后首批下发 / 黑板窗口重建补内容）：整板替换并重建 goto 映射
        aliasToKey.current.clear()
        replyToQuestion.current.clear()
        lastQuestionKey.current = null
        const next: BoardItem[] = []
        for (const m of event.messages) {
          if (m.role === 'user') {
            const key = `q-${++qSeq.current}`
            const aliases = [m.id, key]
            for (const a of aliases) aliasToKey.current.set(a, key)
            lastQuestionKey.current = key
            next.push({ kind: 'question', key, aliases, text: m.text })
          } else {
            next.push({
              kind: 'reply',
              key: `r-${m.id}`,
              messageId: m.id,
              streamText: m.text,
              finalText: m.text,
              interrupted: false,
              done: true
            })
            replyToQuestion.current.set(m.id, lastQuestionKey.current)
          }
        }
        setItems(next)
        break
      }
    }
  }

  const handleInbox = (item: TeachingBoardInbox): void => {
    switch (item.type) {
      case 'mirror':
        applyMirror(item.event)
        break
      case 'goto':
        handleGoto(item.messageId)
        break
      case 'visibility':
        if (item.action === 'fold') {
          // 折叠：记录滚动锚点（主视图 DOM 将卸载，展开时按它恢复）
          const el = scrollRef.current
          if (el) anchorRef.current = { top: el.scrollTop, height: el.scrollHeight }
          applyFolded(true)
        } else if (item.action === 'expand') {
          applyFolded(false)
        }
        // 'exit'：主进程随后滑出并销毁窗口，无需处理
        break
    }
  }
  // 供"订阅一次"的 effect 始终调用最新闭包（handler 内部只用 refs/setState，实际无陈旧风险，双保险）
  const handleInboxRef = useRef(handleInbox)
  handleInboxRef.current = handleInbox

  // ---- 生命周期：订阅 + 就绪 + 补状态（只挂载一次）

  useEffect(() => {
    const t = teaching()
    if (!t) return

    const offInbox = t.onBoardInbox?.((item) => handleInboxRef.current(item))
    const offState = t.onState?.((state) => {
      // 黑板只消费 folded；mode=normal 时窗口即将被销毁，不做额外处理
      if (typeof state?.folded === 'boolean') applyFolded(state.folded)
    })

    t.ready?.() // 通知主进程下发首批数据（history）

    // 补状态：窗口晚于状态广播打开时，靠一次查询对齐 folded（getState 可能尚未落地 → 容错）
    const p = t.getState?.()
    if (p && typeof (p as Promise<unknown>).then === 'function') {
      ;(p as Promise<{ folded?: boolean }>)
        .then((s) => {
          if (s && typeof s.folded === 'boolean') applyFolded(s.folded)
        })
        .catch(() => {})
    }

    return () => {
      offInbox?.()
      offState?.()
    }
    // 依赖数组留空：handler 经 handleInboxRef 转发到最新闭包，且内部只用 refs/setState，订阅一生只挂一次
  }, [])

  // ---- 展开恢复：滚动锚点 / 折叠期间的 goto 补执行

  useLayoutEffect(() => {
    if (folded) return
    const el = scrollRef.current
    if (!el) return
    const anchor = anchorRef.current
    anchorRef.current = null
    if (anchor && anchor.height > 0 && Math.abs(el.scrollHeight - anchor.height) <= 2) {
      el.scrollTop = anchor.top // 内容未变：原位恢复（折叠 ≠ 下课，板面/视点全保留）
    } else {
      el.scrollTop = el.scrollHeight // 内容有变（或首次挂载）：贴底
    }
    updateNearBottom()
    const g = pendingGoto.current
    if (g) {
      pendingGoto.current = null
      const key = resolveGotoKey(g)
      if (key) requestAnimationFrame(() => flashTo(key))
    }
    // 依赖仅 folded：本 effect 只做"展开后恢复视点"，其余状态都经 refs 读取
  }, [folded])

  // ---- 流式跟随：用户贴底时才自动滚底（翻历史时不打扰）

  useEffect(() => {
    if (folded) return
    if (!nearBottomRef.current) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [items, folded])

  // ---- 输入条

  const submit = (): void => {
    const text = draft.trim()
    if (!text) return
    // 黑板不自建消息：发送经主进程转发到宠物面执行 WS 发送，回声再镜像回来（单一来源）
    teaching()?.requestSend?.(text)
    setDraft('')
  }

  const onInputKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  // ---- 渲染

  /** 请求恢复展开（角标点击 / 键盘共用；bridge 可选链容错） */
  const requestUnfold = (): void => {
    teaching()?.requestUnfold?.()
  }

  /**
   * 黑板左缘拖动改宽（2026-10-16 用户定稿）：往左拖变宽，**右缘固定**（主进程保证）。
   * 用"鼠标 screenX 的位移"算目标宽度（不读窗口位置——拖动中本窗左缘正跟着鼠标走、
   * screenX 异步更新不可靠）；拖动中每事件上报，主进程 setBounds + 宠物同帧跟随即"跟手"。
   */
  const onResizeStart = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const t = teaching()
    if (!t?.resizeBoard) return
    e.preventDefault()
    const startMouseX = e.screenX
    const startWidth = window.innerWidth
    const onMove = (ev: PointerEvent): void => {
      // 往左拖（screenX 变小）→ 宽度变大 → 左缘左移 ✓
      t.resizeBoard(startWidth + (startMouseX - ev.screenX))
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return (
    <div className="board-root">
      {folded ? (
        // 折叠角标：div[role=button]（刻意不用 <button>——Chromium 131 之前 button 不能作为
        // flex 容器布局子元素，Electron 33（Chromium 130）下图标与竖排文字会横排/塌陷；
        // 同 theme-card 真机坑，2026-10-15）
        <div
          className="board-badge"
          role="button"
          tabIndex={0}
          title="展开黑板"
          onClick={requestUnfold}
          onKeyDown={(e) => {
            if (e.key === ' ' || e.key === 'Enter') {
              e.preventDefault()
              requestUnfold()
            }
          }}
        >
          <BookIcon />
          <span className="board-badge-label">板书</span>
        </div>
      ) : (
        <div className="board-body">
          {/* 左缘拖动热区（改黑板宽度；仅展开态渲染——折叠态不渲染）：主进程夹取范围 + 宠物同帧跟随 */}
          <div
            className="board-resize-handle"
            role="separator"
            aria-label="拖动调整黑板宽度"
            onPointerDown={onResizeStart}
          />
          <header className="board-header">
            <span className="board-title">板书</span>
            <button
              type="button"
              className="board-close"
              title="下课（结束教学）"
              onClick={() => teaching()?.exit?.()}
            >
              ×
            </button>
          </header>

          <div className="board-scroll" ref={scrollRef} onScroll={updateNearBottom}>
            {items.length === 0 ? (
              <div className="board-empty">
                <div className="board-empty-emoji" aria-hidden="true">
                  ✨
                </div>
                <div className="board-empty-text">问我点什么吧，我来讲解</div>
              </div>
            ) : (
              items.map((it) =>
                it.kind === 'question' ? (
                  <QuestionCard key={it.key} item={it} />
                ) : (
                  <ReplyCard key={it.key} item={it} />
                )
              )
            )}
          </div>

          <footer className="board-composer">
            <input
              className="board-input"
              type="text"
              value={draft}
              placeholder="问点什么…"
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onInputKeyDown}
            />
            <button type="button" className="board-send" disabled={!draft.trim()} onClick={submit}>
              发送
            </button>
          </footer>
        </div>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ 卡片组件

/** 问题卡：小节标题样式 + 问号标记（课堂目录的跳转落点） */
function QuestionCard({ item }: { item: QuestionItem }): JSX.Element {
  return (
    <section className="board-card board-card-question" data-key={item.key}>
      <div className="q-head">
        <span className="q-badge" aria-hidden="true">
          ?
        </span>
        <h3 className="q-text">{item.text}</h3>
      </div>
    </section>
  )
}

/** 讲解卡：思考中（跳点）→ 流式渐进 Markdown（每次 token 整块重渲染）→ 终态（同一渲染函数 + 打断小注） */
function ReplyCard({ item }: { item: ReplyItem }): JSX.Element {
  return (
    <section className="board-card board-card-reply" data-key={item.key}>
      {item.done ? (
        <>
          <div
            className="md-body"
            dangerouslySetInnerHTML={{ __html: renderMarkdownSafe(item.finalText) }}
          />
          {item.interrupted ? <div className="board-note">（被打断）</div> : null}
        </>
      ) : item.streamText ? (
        <div
          className="md-body"
          dangerouslySetInnerHTML={{ __html: renderMarkdownSafe(item.streamText) }}
        />
      ) : (
        <div className="board-thinking" role="status" aria-label="正在思考">
          <span />
          <span />
          <span />
        </div>
      )}
    </section>
  )
}

/** 角标图标：开页书本（线稿；颜色随 currentColor = 角标前景色） */
function BookIcon(): JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 6.5C10.6 5.2 8.6 4.5 6.2 4.5c-.9 0-1.7.1-2.4.3v14c.7-.2 1.5-.3 2.4-.3 2.4 0 4.4.7 5.8 2 1.4-1.3 3.4-2 5.8-2 .9 0 1.7.1 2.4.3v-14c-.7-.2-1.5-.3-2.4-.3-2.4 0-4.4.7-5.8 2z" />
      <path d="M12 6.5v14" />
    </svg>
  )
}
