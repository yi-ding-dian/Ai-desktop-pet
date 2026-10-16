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
import { getPetBridge } from '../../shared/pet-bridge'
import { createPetRenderer, type PetRenderer } from './renderers'
import { setupAirPass } from './air-pass'
import { setActivePetRenderer, setPetEmotion } from './controller'
import { debugTriggerBehavior, interruptPetBehavior } from './behaviors'

/** dev 态日志（转发到主进程日志，便于无 devtools 验证）；生产构建自动剔除 */
const devLog = (msg: string): void => {
  if (import.meta.env.DEV) console.log(`[pet] ${msg}`)
}

/** 点击判定：按下到抬起位移超过该值（px）视为拖拽，不算摸头 */
const TAP_MOVE_THRESHOLD = 6

/**
 * 摸头是否上报后端（pet_event{tap_head}）。
 * 现状（2026-10-14，P3）：后端 dispatcher.on_pet_event 已实现（mood ↑ + 推送轻量
 * emotion 回应），本开关翻为 true；上报失败（未连接）由 ws-client 日志兜底。
 */
const REPORT_TAP_HEAD_TO_BACKEND = true

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
    // 复位容器：防止上一次挂载（HMR 重建 / 异常路径）残留的 DOM 成为"隐形占位"顶坏布局
    // （曾发生：残留的空 stage 把新 canvas 挤到容器外，兔子渲染又小又偏）
    host.replaceChildren()
    // 渲染器由工厂决定缺省（当前为 'glb-model'：加载 Meshy GLB 兔子；
    // localStorage `pet-renderer` 可覆盖为 'three-d' / 'part-animation'）
    const renderer = createPetRenderer()
    renderer.mount(host)
    rendererRef.current = renderer
    // 注册到 pet 域控制器：voice 域口型驱动（setPetMouth）经此转发到当前渲染器
    setActivePetRenderer(renderer)
    // 空气让路（设计文档 §5.1 增补）：像素级命中的判定与上报（渲染器实现 hitTest 时激活；
    // 未实现则零接线，App 旧悬停逻辑保留——见 air-pass.ts 文件头）
    const disposeAirPass = setupAirPass(renderer)
    return () => {
      disposeAirPass()
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
        // 经控制器走"自动回落"策略：挂 N 秒后淡回 neutral；对话/说话中挂起（见 controller.ts）
        setPetEmotion(emotion, intensity || 1)
      }),
      client.on('state', ({ state }) => {
        devLog(`ws state -> ${state}`)
        rendererRef.current?.setState(state)
      })
    ]
    return () => offs.forEach((off) => off())
  }, [client])

  // ---- ②b 魔法球捕获/释放反应（fx 域：隐藏/显示动画由主进程触发；
  //         参考 voice 的控制器模式，经 pet-bridge 订阅后转发给当前渲染器） ----
  // 注：新增 bridge API 需重启 Electron 主进程才可用；旧 preload 无该方法时静默跳过
  useEffect(() => {
    const off = getPetBridge().fx?.onPetReaction?.(({ kind }) => {
      devLog(`fx reaction -> ${kind}`)
      rendererRef.current?.playReaction(kind)
      if (kind === 'captured') {
        // 被魔法球抓走 = 用户交互级打断：中止当前自主行为（walk 等的窗口缓动会与
        // fx 动画的 setBounds 抢窗口控制权，造成抖动；语义同"用户触摸/抓取"）
        interruptPetBehavior('被魔法球捕获')
      }
    })
    return () => off?.()
  }, [])

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
  // 按住 M：口型开合模拟（TTS 未接，验证 setMouth）；数字 1–8：预览 8 种情绪
  // （直连渲染器、不参与自动回落——秒切不会 5 秒后被吞掉，便于定格检查）；0：回 neutral；
  // W：本地注入一条 walk 行为指令；N：注入一条 nap 打盹（30s）——均走真实执行/回报路径
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (isTypingTarget(e.target)) return
      if (e.key === 'm' || e.key === 'M') {
        if (!e.repeat) rendererRef.current?.setMouth(1)
        return
      }
      if (e.key === 'w' || e.key === 'W') {
        if (!e.repeat) debugTriggerBehavior('walk', { direction: 'right', distance: 300, duration_ms: 2200 })
        return
      }
      if (e.key === 'n' || e.key === 'N') {
        if (!e.repeat) debugTriggerBehavior('nap', { duration_ms: 30_000 })
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
