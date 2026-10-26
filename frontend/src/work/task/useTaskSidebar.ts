/**
 * 任务左栏宽度与折叠（2026-10-26 从 TaskPanel 抽出）。
 * 宽度可拖动、持久化到 localStorage；拖到接近最左边时吸附折叠。
 */
import {
  useCallback,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent
} from 'react'

/** 左侧任务列表宽度（可拖动） */
const SIDEBAR_KEY = 'pet.task.sidebarWidth'
const SIDEBAR_DEFAULT = 216
const SIDEBAR_MIN = 140
const SIDEBAR_MAX = 360
/** 拖动时的硬下限：低于它松手即折叠（折叠态宽度由 TaskList 自己控制） */
const SIDEBAR_DRAG_MIN = 60

export interface TaskSidebarControls {
  width: number
  collapsed: boolean
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void
  expand: () => void
}

export function useTaskSidebar(): TaskSidebarControls {
  const [width, setWidth] = useState<number>(() => {
    try {
      const raw = Number(localStorage.getItem(SIDEBAR_KEY))
      return Number.isFinite(raw) && raw >= SIDEBAR_MIN && raw <= SIDEBAR_MAX
        ? raw
        : SIDEBAR_DEFAULT
    } catch {
      return SIDEBAR_DEFAULT
    }
  })
  const [collapsed, setCollapsed] = useState(false)
  const dragRef = useRef<{ startX: number; startWidth: number; width: number } | null>(null)

  const save = useCallback((value: number): void => {
    try {
      localStorage.setItem(SIDEBAR_KEY, String(value))
    } catch {
      /* 隐私模式忽略 */
    }
  }, [])

  const onResizeStart = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      event.preventDefault()
      dragRef.current = { startX: event.clientX, startWidth: width, width }
      const move = (e: PointerEvent): void => {
        const drag = dragRef.current
        if (!drag) return
        const next = Math.min(
          SIDEBAR_MAX,
          Math.max(SIDEBAR_DRAG_MIN, drag.startWidth + e.clientX - drag.startX)
        )
        drag.width = next
        setWidth(next)
      }
      const up = (): void => {
        window.removeEventListener('pointermove', move)
        const drag = dragRef.current
        dragRef.current = null
        if (!drag) return
        if (drag.width < SIDEBAR_MIN) {
          // 拖到靠近最左边：吸附折叠
          setCollapsed(true)
          setWidth(SIDEBAR_DEFAULT)
          save(SIDEBAR_DEFAULT)
        } else {
          setCollapsed(false)
          setWidth(drag.width)
          save(drag.width)
        }
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up, { once: true })
    },
    [width, save]
  )

  const expand = useCallback((): void => {
    setCollapsed(false)
    setWidth(SIDEBAR_DEFAULT)
    save(SIDEBAR_DEFAULT)
  }, [save])

  return { width, collapsed, onResizeStart, expand }
}
