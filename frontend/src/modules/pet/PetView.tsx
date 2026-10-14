/**
 * 宠物视图：pet 域的 React 集成层（唯一使用 React 的地方）。
 *
 * 职责边界：
 * - 渲染器（SVG/将来 Live2D）不依赖 React，本组件只做四件事：
 *   ① 挂载/卸载渲染器；② 把 WS 事件流进渲染器；③ 摸头手势；④ 调试快捷键。
 * - 事件订阅方式与 chat 域一致（设计文档 §5.5：各业务域自行订阅 type）。
 *
 * 手势约定（设计文档 §5.3）：单击 = 摸头（本地即时反应 + 上报 backend pet_event）；
 * 拖拽由 App.tsx 的窗口拖拽逻辑处理（本组件只做"点击 vs 拖拽"的位移判定）。
 */
import { useEffect, useRef, type ReactElement } from 'react'
import type { WsClient } from '../../shared/ws-client'
import { EMOTION_VALUES } from '../../shared/protocol'
import { createPetRenderer, type PetRenderer } from './renderers'
import { setActivePetRenderer } from './controller'

/** dev 态日志（转发到主进程日志，便于无 devtools 验证）；生产构建自动剔除 */
const devLog = (msg: string): void => {
  if (import.meta.env.DEV) console.log(`[pet] ${msg}`)
}

/** 点击判定：按下到抬起位移超过该值（px）视为拖拽，不算摸头 */
const TAP_MOVE_THRESHOLD = 6

/**
 * 摸头是否上报后端（pet_event{tap_head}）。
 * 现状（2026-10-14）：后端流水线尚未实现 pet_event → 上报会收到 NOT_IMPLEMENTED error 事件
 * （chat 域显示错误气泡、状态栏出现 ⚠ 文本，体验变差），故默认关闭；
 * 后端实现该事件后把本开关置 true 即可（协议模型 PetEventData 已就绪，发送路径已留）。
 */
const REPORT_TAP_HEAD_TO_BACKEND = false

/** 调试键是否发生在输入场景（输入框/文本域/可编辑区）：是则不拦截 */
function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || !el.tagName) return false
  const tag = el.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || el.isContentEditable
}

interface PetViewProps {
  /** WS 客户端（订阅 emotion/state；摸头事件经它上报后端） */
  client: WsClient
}

export default function PetView({ client }: PetViewProps): ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const rendererRef = useRef<PetRenderer | null>(null)

  // ---- ① 挂载渲染器（生命周期与 DOM 一致；StrictMode 双调用安全：重建新实例） ----
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const renderer = createPetRenderer('part-animation')
    renderer.mount(host)
    rendererRef.current = renderer
    // 注册到 pet 域控制器：voice 域口型驱动（setPetMouth）经此转发到当前渲染器
    setActivePetRenderer(renderer)
    return () => {
      rendererRef.current = null
      setActivePetRenderer(null)
      renderer.dispose()
    }
  }, [])

  // ---- ② WS 事件 → 渲染器（与 chat 域同款订阅方式） ----
  useEffect(() => {
    const offs = [
      client.on('emotion', ({ emotion, intensity }) => {
        devLog(`ws emotion -> ${emotion}`)
        rendererRef.current?.setEmotion(emotion, intensity || 1)
      }),
      client.on('state', ({ state }) => {
        devLog(`ws state -> ${state}`)
        rendererRef.current?.setState(state)
      })
    ]
    return () => offs.forEach((off) => off())
  }, [client])

  // ---- ③ 摸头手势：window 级监听（hitbox 的 pointer capture 会把事件绑到容器，
  //         window capture 阶段能稳定收到；起点在宠物区域内 + 位移小 = 点击） ----
  useEffect(() => {
    let pending: { x: number; y: number } | null = null
    let moved = false

    const onDown = (e: PointerEvent): void => {
      if (e.button !== 0) return
      const host = hostRef.current
      if (!host) return
      const r = host.getBoundingClientRect()
      const inside = e.clientX >= r.left && e.clientX < r.right && e.clientY >= r.top && e.clientY < r.bottom
      pending = inside ? { x: e.clientX, y: e.clientY } : null
      moved = false
    }
    const onMove = (e: PointerEvent): void => {
      if (!pending || moved) return
      if (Math.hypot(e.clientX - pending.x, e.clientY - pending.y) > TAP_MOVE_THRESHOLD) {
        moved = true // 判定为拖拽，不再视为点击
      }
    }
    const onUp = (e: PointerEvent): void => {
      if (!pending) return
      const wasTap = !moved
      pending = null
      moved = false
      if (!wasTap || e.button !== 0) return
      // 摸头：本地即时反应（+ 可选上报后端，见 REPORT_TAP_HEAD_TO_BACKEND 说明）
      rendererRef.current?.playReaction('pet')
      if (REPORT_TAP_HEAD_TO_BACKEND) {
        const sent = client.send('pet_event', { kind: 'tap_head', payload: {} })
        devLog(`tap_head（pet_event 上报=${sent}）`)
      } else {
        devLog('tap_head（本地反应；pet_event 上报暂缓——后端未实现该事件）')
      }
    }

    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('pointermove', onMove, true)
    window.addEventListener('pointerup', onUp, true)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('pointermove', onMove, true)
      window.removeEventListener('pointerup', onUp, true)
    }
  }, [client])

  // ---- ④ 调试快捷键（窗口聚焦时；输入框内不拦截）----
  // 按住 M：口型开合模拟（TTS 未接，验证 setMouth）；数字 1–8：预览 8 种情绪；0：回 neutral
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (isTypingTarget(e.target)) return
      if (e.key === 'm' || e.key === 'M') {
        if (!e.repeat) rendererRef.current?.setMouth(1)
        return
      }
      if (/^[0-8]$/.test(e.key)) {
        const emotion = e.key === '0' ? 'neutral' : EMOTION_VALUES[Number(e.key) - 1]
        if (emotion) {
          rendererRef.current?.setEmotion(emotion, 1)
          devLog(`debug emotion -> ${emotion}`)
        }
      }
    }
    const onKeyUp = (e: KeyboardEvent): void => {
      if (isTypingTarget(e.target)) return
      if (e.key === 'm' || e.key === 'M') rendererRef.current?.setMouth(0)
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [])

  return <div ref={hostRef} className="pet-view" data-testid="pet-view" />
}
