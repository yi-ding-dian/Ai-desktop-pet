/**
 * 输入框「已发送消息」历史（2026-10-25）：对话 / 任务两页共用。
 *
 * - 左侧历史按钮 → 向上弹层（HH:mm + 单行省略，悬浮 title 看全文）
 * - 点文字填入输入框；点时间定位到消息流（由调用方提供 onLocate）
 * - 弹层打开：↑↓ 选行、Enter 填入、Alt+Enter 定位、Esc 关闭
 * - 弹层关闭：输入框内 ↑/↓ 翻阅，翻过最新一条恢复原草稿
 *
 * 数据由调用方派生（对话：message/history.ts；任务：task/history.ts），本组件只负责交互。
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MutableRefObject,
  type ReactElement
} from 'react'
import { formatTime } from '../format'
import type { ComposerHistoryItem } from './history'

export interface ComposerHistoryControls {
  open: boolean
  openIndex: number
  history: ComposerHistoryItem[]
  buttonRef: MutableRefObject<HTMLButtonElement | null>
  popoverRef: MutableRefObject<HTMLDivElement | null>
  listRef: MutableRefObject<HTMLDivElement | null>
  activeRowRef: MutableRefObject<HTMLDivElement | null>
  toggle: () => void
  close: (focusInput?: boolean) => void
  handleInputKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => boolean
  handlePopoverKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void
  /** Textarea 的 onValueChange 用：用户手动输入时退出历史翻阅 */
  onInputChange: (value: string) => void
  /** 发送成功后清掉翻阅状态（草稿/下标） */
  reset: () => void
  choose: (item: ComposerHistoryItem) => void
  locate: (item: ComposerHistoryItem) => void
}

interface UseComposerHistoryOptions {
  value: string
  onValueChange: (value: string) => void
  history: ComposerHistoryItem[]
  /** 切换会话/任务时重置 */
  scopeKey: string
  onLocate: (item: ComposerHistoryItem) => void
  textareaRef: MutableRefObject<HTMLTextAreaElement | null>
  /** 输入框不可用时只回写 value，不抢焦点 */
  fillDisabled?: boolean
}

export function useComposerHistory({
  value,
  onValueChange,
  history,
  scopeKey,
  onLocate,
  textareaRef,
  fillDisabled = false
}: UseComposerHistoryOptions): ComposerHistoryControls {
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const activeRowRef = useRef<HTMLDivElement | null>(null)
  const historyCursorRef = useRef<number | null>(null)
  const historyDraftRef = useRef('')
  const [open, setOpen] = useState(false)
  const [openIndex, setOpenIndex] = useState(-1)

  // 切换会话/任务：关闭弹层、清空翻阅状态（草稿属于原会话）
  useEffect(() => {
    historyCursorRef.current = null
    historyDraftRef.current = ''
    setOpen(false)
    setOpenIndex(-1)
  }, [scopeKey])

  // 弹层打开/选中变化：选中行滚到可视区并聚焦
  useLayoutEffect(() => {
    if (!open) return
    const row = activeRowRef.current
    const list = listRef.current
    if (!row) return
    row.focus({ preventScroll: true })
    if (list) {
      const top = row.offsetTop
      const bottom = top + row.offsetHeight
      if (top < list.scrollTop) list.scrollTop = top
      else if (bottom > list.scrollTop + list.clientHeight) {
        list.scrollTop = bottom - list.clientHeight
      }
    }
  }, [open, openIndex])

  // 点外面关闭（历史按钮自己不算外面，否则 toggle 会先关再开）
  useEffect(() => {
    if (!open) return
    const onDown = (event: PointerEvent): void => {
      const target = event.target as Node | null
      if (target && (popoverRef.current?.contains(target) || buttonRef.current?.contains(target))) {
        return
      }
      setOpen(false)
      setOpenIndex(-1)
    }
    window.addEventListener('pointerdown', onDown)
    return () => window.removeEventListener('pointerdown', onDown)
  }, [open])

  const close = useCallback(
    (focusInput = true): void => {
      setOpen(false)
      setOpenIndex(-1)
      if (focusInput && !fillDisabled) textareaRef.current?.focus()
    },
    [fillDisabled, textareaRef]
  )

  /** 填入历史文本（光标放到末尾；输入框禁用时只回写 value） */
  const setValueFromHistory = useCallback(
    (text: string): void => {
      onValueChange(text)
      window.requestAnimationFrame(() => {
        const element = textareaRef.current
        if (!element || fillDisabled) return
        element.focus()
        element.setSelectionRange(text.length, text.length)
      })
    },
    [fillDisabled, onValueChange, textareaRef]
  )

  const openHistory = useCallback((): void => {
    if (history.length === 0) return
    setOpenIndex(history.length - 1)
    setOpen(true)
  }, [history.length])

  const toggle = useCallback((): void => {
    if (open) close()
    else openHistory()
  }, [close, open, openHistory])

  const reset = useCallback((): void => {
    historyCursorRef.current = null
    historyDraftRef.current = ''
  }, [])

  const onInputChange = useCallback(
    (next: string): void => {
      reset()
      onValueChange(next)
    },
    [onValueChange, reset]
  )

  const choose = useCallback(
    (item: ComposerHistoryItem): void => {
      const index = history.findIndex((entry) => entry.id === item.id)
      historyDraftRef.current = value
      historyCursorRef.current = index >= 0 ? index : null
      setValueFromHistory(item.text)
      close()
    },
    [close, history, setValueFromHistory, value]
  )

  const locate = useCallback(
    (item: ComposerHistoryItem): void => {
      onLocate(item)
      close()
    },
    [close, onLocate]
  )

  const recallOlder = useCallback((): void => {
    if (history.length === 0) return
    const cursor = historyCursorRef.current
    if (cursor === null) {
      historyDraftRef.current = value
      historyCursorRef.current = history.length - 1
    } else if (cursor > 0) {
      historyCursorRef.current = cursor - 1
    } else {
      return
    }
    setValueFromHistory(history[historyCursorRef.current].text)
  }, [history, setValueFromHistory, value])

  const recallNewer = useCallback((): void => {
    const cursor = historyCursorRef.current
    if (cursor === null) return
    if (cursor < history.length - 1) {
      historyCursorRef.current = cursor + 1
      setValueFromHistory(history[historyCursorRef.current].text)
      return
    }
    historyCursorRef.current = null
    const draft = historyDraftRef.current
    historyDraftRef.current = ''
    setValueFromHistory(draft)
  }, [history, setValueFromHistory])

  /** 返回 true = 这次按键已被历史翻阅处理（调用方不要再处理 Enter 等） */
  const handleInputKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (event.nativeEvent.isComposing) return false
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return false
    if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return false
    if (history.length === 0) return false
    const element = event.currentTarget
    const browsing = historyCursorRef.current !== null
    // 光标在首行才用 ↑、末行才用 ↓，避免抢多行输入里的光标移动；
    // 单行输入任意位置都算首行/末行。
    const onFirstLine = !element.value.slice(0, element.selectionStart).includes('\n')
    const onLastLine = !element.value.slice(element.selectionEnd).includes('\n')
    if (event.key === 'ArrowUp') {
      if (!browsing && !onFirstLine) return false
      event.preventDefault()
      recallOlder()
      return true
    }
    if (browsing && onLastLine) {
      event.preventDefault()
      recallNewer()
      return true
    }
    return false
  }

  const handlePopoverKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setOpenIndex((index) => Math.max(0, index - 1))
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setOpenIndex((index) => Math.min(history.length - 1, index + 1))
      return
    }
    if (event.key === 'Enter') {
      const item = history[openIndex]
      if (!item) return
      event.preventDefault()
      if (event.altKey) locate(item)
      else choose(item)
    }
  }

  return {
    open,
    openIndex,
    history,
    buttonRef,
    popoverRef,
    listRef,
    activeRowRef,
    toggle,
    close,
    handleInputKeyDown,
    handlePopoverKeyDown,
    onInputChange,
    reset,
    choose,
    locate
  }
}

function HistoryIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 3v6h6" />
      <path d="M12 7v5l3 2" />
    </svg>
  )
}

/** 输入框左侧的历史按钮 */
export function ComposerHistoryButton({
  controls
}: {
  controls: ComposerHistoryControls
}): ReactElement {
  return (
    <button
      type="button"
      className="work-attach composer-history-toggle"
      ref={controls.buttonRef}
      title="已发送的消息（↑/↓ 快速调取）"
      aria-label="已发送的消息"
      aria-haspopup="listbox"
      aria-expanded={controls.open}
      disabled={controls.history.length === 0}
      onMouseDown={(event) => event.preventDefault()}
      onClick={controls.toggle}
    >
      <HistoryIcon />
    </button>
  )
}

/** 向上展开的历史弹层 */
export function ComposerHistoryPopover({
  controls
}: {
  controls: ComposerHistoryControls
}): ReactElement | null {
  if (!controls.open) return null
  return (
    <div
      className="composer-history"
      ref={controls.popoverRef}
      role="listbox"
      aria-label="已发送的消息"
      onKeyDown={controls.handlePopoverKeyDown}
    >
      <div className="composer-history-head">
        <span>本会话已发送</span>
        <span className="composer-history-hint">Enter 填入 · Alt+Enter 定位</span>
      </div>
      <div className="composer-history-list pui-scroll" ref={controls.listRef}>
        {controls.history.map((item, index) => (
          <div
            key={item.id}
            role="option"
            aria-selected={index === controls.openIndex}
            tabIndex={index === controls.openIndex ? 0 : -1}
            ref={index === controls.openIndex ? controls.activeRowRef : undefined}
            className={`composer-history-row${
              index === controls.openIndex ? ' is-active' : ''
            }`}
            title={item.text}
            onClick={() => controls.choose(item)}
          >
            <button
              type="button"
              className="composer-history-time"
              title="定位到这条消息"
              onClick={(event) => {
                event.stopPropagation()
                controls.locate(item)
              }}
              onKeyDown={(event) => {
                // 时间按钮自己的 Enter/Space 走定位，不再冒出到弹层的"填入"
                if (event.key === 'Enter' || event.key === ' ') event.stopPropagation()
              }}
            >
              {item.at === null ? '--:--' : formatTime(item.at)}
            </button>
            <span className="composer-history-text">{item.text}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
