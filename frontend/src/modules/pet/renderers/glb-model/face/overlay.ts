/**
 * SVG 表情叠加层（glb-model 渲染器内部实现细节）。
 *
 * 结构：在渲染器自己的容器里放一个 stage（相对定位，宽高 100%），stage 内叠一层 SVG
 * （绝对定位铺满、pointer-events:none 不挡手势）。Three.js 画布也挂进 stage（渲染器负责）。
 * 这样不依赖容器自身的 position 类型，也不触碰 App.tsx / styles.css
 * （样式全部内联 + 注入到 SVG 内部的 <style>，只作用于本层）。
 *
 * 跟随原理（每帧 O(1) 次变换）：
 * - 渲染器每帧把脸坐标系（原点=两眼中点，见 config.ts）的 O、O+ex、O+eyDown 三点投影到
 *   屏幕，得到 FaceFrame { ox,oy, ax,ay, bx,by }（O 的屏幕坐标 + 两个基向量的屏幕投影）；
 * - 本层把它写成根 <g> 的 transform="matrix(ax ay bx by ox oy)"，于是**所有 2D 元素都在
 *   脸坐标系里排版**，自动跟随头部姿态（弹跳/歪头/转头/缩放）与透视；
 * - 每帧再驱动两个连续量：上/下眼皮的扫动位移（translate）+ 眼睑线透明度。
 *   其余开关型元素（眉/泪/符号/腮红…）走 CSS 过渡，切换情绪时才写 DOM。
 *
 * 眨眼：上眼皮用 sin 半波从上方扫下再抬起（全程 BLINK.duration ≈ 0.15s），随机 2–6s 一次、
 * 18% 概率双眨；睡着（state=sleeping）时停眨并维持半合。
 *
 * DOM 约定（重要）：
 * - 定位一律用**属性 transform**（外层 g），动画/缩放一律用**CSS transform**（内层 g，
 *   .pfx-pop / .pfx-float）——CSS transform 会覆盖属性 transform，两者必须分层，混用会跑位。
 */
import type { Emotion, PetState } from '../../../../../shared/protocol'
import {
  ANCHORS,
  BLINK,
  BLUSH_ALPHA_MAX,
  BROW,
  COLORS,
  EMOTION_FACES,
  EYE_RING,
  INTENSITY,
  LID,
  OPEN_MOUTH,
  SQUIGGLE,
  SYMBOLS,
  TAU_LID,
  TEAR,
  stateFaceOverride,
  type BrowKind,
  type FaceAnchor
} from './config'

/** 渲染器每帧算出的脸坐标系 → 屏幕仿射（屏幕 px；见文件头） */
export interface FaceFrame {
  /** 脸坐标系原点 O 的屏幕坐标 */
  ox: number
  oy: number
  /** +x 基向量（世界单位 → 屏幕 px 向量） */
  ax: number
  ay: number
  /** +y（屏幕下）基向量 */
  bx: number
  by: number
}

const NS = 'http://www.w3.org/2000/svg'

/** 实例序号（clipPath/gradient 的 id 唯一化，防 HMR 重建时短暂并存期冲突） */
let overlaySeq = 0

/** 创建 SVG 元素并设属性 */
function el<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {}
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(NS, tag)
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v))
  return node
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))
const rand = (a: number, b: number): number => a + Math.random() * (b - a)

/** 眼皮结构（每只眼睛一套；含动画所需的 ry） */
interface EyeParts {
  ry: number
  /** 眼皮扫动组（每帧写 transform=translate(0, base)） */
  topMove: SVGGElement
  botMove: SVGGElement
  /** 眼睑线（每帧写 opacity 属性） */
  topLine: SVGPathElement
  botLine: SVGPathElement
}

export class FaceOverlay {
  /** stage 容器（渲染器把 canvas 也挂这里；相对定位，让 SVG 绝对定位有基准） */
  private stage: HTMLDivElement | null = null
  /** 叠加层 SVG（stage 的子元素） */
  private svg: SVGSVGElement | null = null
  /** 脸坐标系根组（每帧写矩阵） */
  private frameG: SVGGElement | null = null
  private eyes: { L: EyeParts; R: EyeParts } | null = null
  /** 腮红淡入组（setEmotion 时写 inline opacity） */
  private blushFades: SVGGElement[] = []
  /** 渐变 id（实例唯一） */
  private gradRef = ''

  // ---- 接口状态 ----
  private emotion: Emotion = 'neutral'
  private intensity = 1
  private state: PetState = 'idle'

  // ---- 每帧连续量（按"闭合度"差分写 DOM，阈值内不碰） ----
  // 初值用 -2（必与首帧的 p∈[0,1] 相差 > 阈值 → 首帧必写；若用 NaN 则比较恒 false 永不写）
  private lidTopCur = 0
  private lidBotCur = 0
  private wroteLidTopP = -2
  private wroteLidBotP = -2
  private wroteLineTop = -2
  private wroteLineBot = -2

  // ---- 眨眼状态机 ----
  private blinkT = -1
  private nextBlink = BLINK.minGap * BLINK.firstGapScale
  private doubleSecond = false
  private blinkEnabled = true
  /** 调试：强制眨眼相位（0=睁 … 1=全闭；null = 正常随机眨眼） */
  private blinkForced: number | null = null
  /** 睡姿模型接管时隐藏整层（优先于 update 的 display 写入） */
  private suppressed = false

  /**
   * 调试钩子：冻结眨眼相位（供离屏截图验证 / 人工调参 / devtools 演示）。
   * 例：__pet.face.debugForceBlink(1) 定格全闭；debugForceBlink(null) 恢复正常眨眼。
   */
  debugForceBlink(phase: number | null): void {
    this.blinkForced = phase === null ? null : clamp01(phase)
    if (phase === null) {
      this.blinkT = -1
      this.nextBlink = rand(BLINK.minGap, BLINK.maxGap)
    }
  }

  /** 挂载：建 stage + SVG 并加入容器；返回 stage（渲染器把 canvas 挂进来，插在 SVG 之前） */
  attach(container: HTMLElement): HTMLElement {
    this.detach()
    const stage = document.createElement('div')
    // 注意：stage 不设 pointer-events（canvas 的点击/拖拽行为与之前完全一致）；
    // 穿透只由上层 SVG 自己声明 pointer-events:none 完成
    stage.style.cssText = 'position:relative;width:100%;height:100%;overflow:visible;'
    const svg = this.buildSvg()
    stage.appendChild(svg)
    container.appendChild(stage)
    this.stage = stage
    this.svg = svg
    return stage
  }

  /** 卸载 DOM（保留情绪/眨眼状态，再 attach 时接着用） */
  detach(): void {
    this.stage?.remove()
    this.stage = null
    this.svg = null
    this.frameG = null
    this.eyes = null
    this.blushFades = []
    this.wroteLidTopP = -2
    this.wroteLidBotP = -2
    this.wroteLineTop = -2
    this.wroteLineBot = -2
  }

  /** 彻底清理（与 detach 相同；保留独立方法以便将来释放额外资源） */
  dispose(): void {
    this.detach()
  }

  // ------------------------------------------------------------------ 指令

  setEmotion(emotion: Emotion, intensity: number): void {
    this.emotion = emotion
    this.intensity = clamp01(intensity)
    this.applyEmotionDom()
  }

  setState(state: PetState): void {
    this.state = state
    this.blinkEnabled = state !== 'sleeping'
    if (this.frameG) this.frameG.setAttribute('data-state', state)
  }

  /**
   * 睡眠时切到睡姿模型：隐藏 SVG 表情层（睡姿模型自带闭眼）。
   * 只改 display，不动内部状态；唤醒后恢复。
   */
  setSuppressed(value: boolean): void {
    if (this.suppressed === value) return
    this.suppressed = value
    if (this.svg) this.svg.style.display = value ? 'none' : ''
  }

  /** 把当前情绪/强度写入 DOM（data 属性 + 腮红透明度；可重复调用，幂等） */
  private applyEmotionDom(): void {
    const frameG = this.frameG
    if (!frameG) return
    frameG.setAttribute('data-emotion', this.emotion)
    const fx = EMOTION_FACES[this.emotion]
    const alpha =
      fx.blush * BLUSH_ALPHA_MAX * (INTENSITY.blushLow + (1 - INTENSITY.blushLow) * this.intensity)
    for (const g of this.blushFades) g.style.opacity = alpha.toFixed(3)
  }

  // ------------------------------------------------------------------ 每帧更新

  /**
   * 每帧更新（由渲染器在 render 之后调用，此时 root/camera 矩阵最新）。
   * @param dt 秒（已钳制）
   * @param frame 脸坐标系投影；null = 模型未就绪 → 隐藏叠加层
   */
  update(dt: number, frame: FaceFrame | null): void {
    const svg = this.svg
    const frameG = this.frameG
    if (!svg || !frameG) return

    // 睡姿模型接管：整层保持隐藏（优先于下面的 display 重置）
    if (this.suppressed) {
      svg.style.display = 'none'
      return
    }

    if (!frame) {
      svg.style.display = 'none'
      return
    }
    svg.style.display = ''

    // ① 整层跟随：写脸坐标系 → 屏幕的仿射矩阵
    frameG.setAttribute(
      'transform',
      `matrix(${frame.ax.toFixed(3)} ${frame.ay.toFixed(3)} ${frame.bx.toFixed(3)} ${frame.by.toFixed(3)} ${frame.ox.toFixed(2)} ${frame.oy.toFixed(2)})`
    )

    // ② 眼皮目标：情绪 × 强度，叠加 state 覆盖（sleeping 半合），指数阻尼平滑
    const fx = EMOTION_FACES[this.emotion]
    const ov = stateFaceOverride(this.state)
    const lidK = INTENSITY.lidLow + (1 - INTENSITY.lidLow) * this.intensity
    const tTop = Math.max(fx.lidTop * lidK, ov ? ov.lidTop : 0)
    const tBot = fx.lidBot * lidK
    const k = 1 - Math.exp(-dt / TAU_LID)
    this.lidTopCur += (tTop - this.lidTopCur) * k
    this.lidBotCur += (tBot - this.lidBotCur) * k

    // ③ 眨眼相位（睡着时停眨；调试冻结时直接用固定相位）
    let blinkP = 0
    if (this.blinkForced !== null) {
      blinkP = this.blinkForced
    } else if (!this.blinkEnabled) {
      this.blinkT = -1
      this.nextBlink = BLINK.minGap
    } else if (this.blinkT >= 0) {
      this.blinkT += dt
      const u = this.blinkT / BLINK.duration
      if (u >= 1) {
        this.blinkT = -1
        this.scheduleNextBlink()
      } else {
        blinkP = Math.pow(Math.sin(Math.PI * u), BLINK.shapePow)
      }
    } else {
      this.nextBlink -= dt
      if (this.nextBlink <= 0) this.blinkT = 0
    }

    // ④ 写眼皮：上眼皮取 max(情绪闭合, 眨眼相位)；下眼皮独立
    this.applyLids(Math.max(this.lidTopCur, blinkP), this.lidBotCur)
  }

  /** 眨眼结束 → 排下一次（含双眨：19% 概率 0.26s 后再眨一次） */
  private scheduleNextBlink(): void {
    if (this.doubleSecond) {
      this.doubleSecond = false
      this.nextBlink = rand(BLINK.minGap, BLINK.maxGap)
      return
    }
    if (Math.random() < BLINK.doubleChance) {
      this.doubleSecond = true
      this.nextBlink = BLINK.doubleGap
    } else {
      this.nextBlink = rand(BLINK.minGap, BLINK.maxGap)
    }
  }

  /**
   * 写两只眼睛的眼皮（按"闭合度"差分：变化 < 阈值不碰 DOM）。
   * 上眼皮基线从 LID.openBase 扫到 LID.closedBase（ry 倍数）；下眼皮镜像（openBot → closedBot）。
   * 左/右眼 ry 不同（模型本身左右脸不对称），所以两只眼都要写。
   */
  private applyLids(pTop: number, pBot: number): void {
    const eyes = this.eyes
    if (!eyes) return
    if (Math.abs(pTop - this.wroteLidTopP) > 0.002) {
      const base = LID.openBase + (LID.closedBase - LID.openBase) * clamp01(pTop)
      for (const eye of [eyes.L, eyes.R]) {
        eye.topMove.setAttribute('transform', `translate(0 ${(base * eye.ry).toFixed(4)})`)
      }
      this.wroteLidTopP = pTop
    }
    if (Math.abs(pBot - this.wroteLidBotP) > 0.002) {
      const base = LID.openBot + (LID.closedBot - LID.openBot) * clamp01(pBot)
      for (const eye of [eyes.L, eyes.R]) {
        eye.botMove.setAttribute('transform', `translate(0 ${(base * eye.ry).toFixed(4)})`)
      }
      this.wroteLidBotP = pBot
    }
    // 眼睑线：闭合度越高越明显（LID.lineFrom → lineTo 线性渐显）
    const lineTop = clamp01((pTop - LID.lineFrom) / (LID.lineTo - LID.lineFrom))
    const lineBot = clamp01((pBot - LID.lineFrom) / (LID.lineTo - LID.lineFrom))
    if (Math.abs(lineTop - this.wroteLineTop) > 0.02) {
      eyes.L.topLine.setAttribute('opacity', lineTop.toFixed(2))
      eyes.R.topLine.setAttribute('opacity', lineTop.toFixed(2))
      this.wroteLineTop = lineTop
    }
    if (Math.abs(lineBot - this.wroteLineBot) > 0.02) {
      eyes.L.botLine.setAttribute('opacity', lineBot.toFixed(2))
      eyes.R.botLine.setAttribute('opacity', lineBot.toFixed(2))
      this.wroteLineBot = lineBot
    }
  }

  // ------------------------------------------------------------------ DOM 构建

  /** 构建整层 SVG（一次性；图形静态生成，运行时只改 transform/opacity/data 属性） */
  private buildSvg(): SVGSVGElement {
    const id = `pfx${++overlaySeq}`
    this.gradRef = `url(#${id}-blush)`
    const svg = el('svg', {
      // 不设 viewBox：用户单位 = CSS px，元素坐标走脸坐标系（由根组 matrix 缩放）
      style:
        'position:absolute;left:0;top:0;width:100%;height:100%;overflow:visible;' +
        'pointer-events:none;z-index:2;display:none'
    })
    svg.appendChild(el('style')).textContent = buildCss()

    // ---- defs：腮红径向渐变（柔边）+ 两只眼的裁剪椭圆（眼皮只在眼形内可见） ----
    const defs = el('defs')
    const grad = el('radialGradient', { id: `${id}-blush` })
    grad.appendChild(el('stop', { offset: '0%', 'stop-color': COLORS.blush, 'stop-opacity': 0.75 }))
    grad.appendChild(el('stop', { offset: '55%', 'stop-color': COLORS.blush, 'stop-opacity': 0.42 }))
    grad.appendChild(el('stop', { offset: '100%', 'stop-color': COLORS.blush, 'stop-opacity': 0 }))
    defs.appendChild(grad)
    for (const side of ['L', 'R'] as const) {
      const a = side === 'L' ? ANCHORS.eyeL : ANCHORS.eyeR
      const clip = el('clipPath', { id: `${id}-eyeclip-${side}` })
      clip.appendChild(
        el('ellipse', { cx: 0, cy: 0, rx: (a.rx * 1.22).toFixed(4), ry: (a.ry * 1.28).toFixed(4) })
      )
      defs.appendChild(clip)
    }
    svg.appendChild(defs)

    // ---- 根组（脸坐标系；data-emotion / data-state 驱动 CSS 显隐） ----
    const frameG = el('g', { 'data-emotion': this.emotion, 'data-state': this.state })
    svg.appendChild(frameG)
    this.frameG = frameG

    // 绘制顺序（先=底层）：腮红 → 眼睛（外圈/眼皮/泪光/眉） → 嘴 → 符号
    this.buildBlush(frameG, 'cheekL')
    this.buildBlush(frameG, 'cheekR')
    this.eyes = { L: this.buildEye(frameG, id, 'L'), R: this.buildEye(frameG, id, 'R') }
    this.buildOpenMouth(frameG)
    this.buildSymbols(frameG)

    this.applyEmotionDom() // 初始情绪（缺省 neutral 的淡腮红）立即生效
    return svg
  }

  /** "外层定位 + 内层动画"包装（见文件头 DOM 约定） */
  private popWrap(
    frameG: SVGGElement,
    cls: string,
    x: number,
    y: number
  ): SVGGElement {
    const outer = el('g', { transform: `translate(${x.toFixed(4)} ${y.toFixed(4)})` })
    const inner = el('g', { class: `pfx-pop ${cls}` })
    outer.appendChild(inner)
    frameG.appendChild(outer)
    return inner
  }

  /** 腮红：粉色柔边椭圆 + （shy 用）"///" 三条短斜线 */
  private buildBlush(frameG: SVGGElement, key: 'cheekL' | 'cheekR'): void {
    const a = ANCHORS[key]
    const outer = el('g', { class: 'pfx-blush', transform: `translate(${a.x} ${a.y})` })
    const fade = el('g', { class: 'pfx-fade' })
    fade.appendChild(el('ellipse', { rx: a.rx, ry: a.ry, fill: this.gradRef }))
    fade.appendChild(el('g')) // 占位保持顺序稳定（无实际内容）
    outer.appendChild(fade)
    frameG.appendChild(outer)
    this.blushFades.push(fade)

    // shy 的 "///"（相对腮红中心，右上方；独立于腮红的透明度）
    const sq = this.popWrap(frameG, 'pfx-squiggle', a.x + SQUIGGLE.x, a.y + SQUIGGLE.y)
    for (let i = 0; i < 3; i++) {
      const x0 = (i - 1) * SQUIGGLE.gap
      sq.appendChild(
        el('line', {
          x1: (x0 + SQUIGGLE.len * 0.42).toFixed(4),
          y1: (SQUIGGLE.len * 0.5).toFixed(4),
          x2: (x0 - SQUIGGLE.len * 0.42).toFixed(4),
          y2: (-SQUIGGLE.len * 0.5).toFixed(4),
          stroke: COLORS.blush,
          'stroke-width': SQUIGGLE.width,
          'stroke-linecap': 'round'
        })
      )
    }
  }

  /** 眼睛：瞪眼外圈 + 裁剪内的上/下眼皮（含眼睑线）+ 泪光 + 三种眉形 */
  private buildEye(frameG: SVGGElement, id: string, side: 'L' | 'R'): EyeParts {
    const a: FaceAnchor = side === 'L' ? ANCHORS.eyeL : ANCHORS.eyeR
    const inward = side === 'L' ? 1 : -1 // 朝脸中线方向（左眼为 +x）
    const g = el('g', { class: `pfx-eye pfx-eye${side}`, transform: `translate(${a.x} ${a.y})` })

    // 瞪眼外圈（surprised；比眼睛大一圈的浅色描边；无属性 transform，可直接用 CSS 缩放）
    g.appendChild(
      el('ellipse', {
        class: 'pfx-pop pfx-ring',
        rx: (a.rx * EYE_RING.scale).toFixed(4),
        ry: (a.ry * EYE_RING.scale).toFixed(4),
        fill: 'none',
        stroke: COLORS.tear,
        'stroke-width': EYE_RING.width,
        opacity: 0
      })
    )

    // 眼皮（裁剪椭圆内扫动；形状静态，运行时只写 translate / opacity 属性）
    const clipG = el('g', { 'clip-path': `url(#${id}-eyeclip-${side})` })
    const top = buildLidShape(a, 'top')
    const bot = buildLidShape(a, 'bot')
    clipG.appendChild(top.move)
    clipG.appendChild(bot.move)
    g.appendChild(clipG)

    // 泪光（sad：外下眼角两颗淡蓝白小圆）
    const tears = this.popWrap(
      frameG,
      'pfx-tears',
      a.x + TEAR.x * a.rx * inward,
      a.y + TEAR.y * a.ry
    )
    tears.appendChild(el('circle', { cx: 0, cy: 0, r: TEAR.r1, fill: COLORS.tear }))
    tears.appendChild(
      el('circle', { cx: TEAR.r1 * 0.9 * inward, cy: -TEAR.r2 * 1.7, r: TEAR.r2, fill: COLORS.tear })
    )

    // 眉毛：三种形态的 path 都建好，由 CSS 按 [data-emotion] 只显示其中一种
    for (const kind of ['sad', 'angry', 'raise'] as const) {
      g.appendChild(
        el('path', {
          class: `pfx-fade pfx-brow pfx-brow-${kind}`,
          d: browD(kind, a, inward),
          fill: 'none',
          stroke: COLORS.ink,
          'stroke-width': BROW.width,
          'stroke-linecap': 'round'
        })
      )
    }
    frameG.appendChild(g)
    return { ry: a.ry, topMove: top.move, botMove: bot.move, topLine: top.line, botLine: bot.line }
  }

  /** 惊讶小张嘴（嘴锚点处的小椭圆；深色内腔 + 浅色描边） */
  private buildOpenMouth(frameG: SVGGElement): void {
    const m = ANCHORS.mouth
    const inner = this.popWrap(frameG, 'pfx-openmouth', m.x + OPEN_MOUTH.x, m.y + OPEN_MOUTH.y)
    inner.appendChild(
      el('ellipse', {
        rx: OPEN_MOUTH.rx,
        ry: OPEN_MOUTH.ry,
        fill: COLORS.mouthIn,
        stroke: COLORS.mouthEdge,
        'stroke-width': 0.005
      })
    )
  }

  /** 头顶符号：？/ 井 / Zzz（位置见 config.SYMBOLS；Zzz 内层 text 做浮动动画） */
  private buildSymbols(frameG: SVGGElement): void {
    const top = ANCHORS.headTop

    // "？"（thinking）：text 走系统字体（Chromium/Electron 下表现稳定）
    const q = SYMBOLS.question
    const qInner = this.popWrap(frameG, 'pfx-symbol pfx-sym-question', top.x + q.x, top.y + q.y)
    const qText = el('text', {
      'text-anchor': 'middle',
      'dominant-baseline': 'middle',
      'font-family': 'system-ui, sans-serif',
      'font-weight': 700,
      'font-size': q.size,
      fill: COLORS.symbol
    })
    qText.textContent = '?'
    qInner.appendChild(qText)

    // 井号（angry）：两横两竖线手绘（不依赖字体）
    const an = SYMBOLS.anger
    const aInner = this.popWrap(frameG, 'pfx-symbol pfx-sym-anger', top.x + an.x, top.y + an.y)
    const s = an.size
    for (const [x1, y1, x2, y2] of [
      [-s * 0.45, -s * 0.18, s * 0.45, -s * 0.18],
      [-s * 0.45, s * 0.18, s * 0.45, s * 0.18],
      [-s * 0.2, -s * 0.5, -s * 0.2, s * 0.5],
      [s * 0.2, -s * 0.5, s * 0.2, s * 0.5]
    ]) {
      aInner.appendChild(
        el('line', {
          x1: x1.toFixed(4),
          y1: y1.toFixed(4),
          x2: x2.toFixed(4),
          y2: y2.toFixed(4),
          stroke: COLORS.symbolHot,
          'stroke-width': 0.006,
          'stroke-linecap': 'round'
        })
      )
    }

    // Zzz（sleepy / sleeping）：三个递减的 Z，左上方向飘（SMIL 浮动，见下）
    const zOuter = el('g', { class: 'pfx-pop pfx-symbol pfx-sym-zzz' })
    SYMBOLS.zzz.forEach((z, i) => {
      const zz = el('g', {
        transform: `translate(${(top.x + z.x).toFixed(4)} ${(top.y + z.y).toFixed(4)})`
      })
      // 浮动动画用 SMIL（additive=sum 叠加在既有 translate 上）：
      // 不用 CSS translateY(%)——百分比在 SVG 子元素上按包含块(832px)解析而非自身高度，
      // 会把 Z 甩出画面（实测 316px 偏移）。SMIL 的 values 用绝对用户单位，行为确定。
      zz.appendChild(
        el('animateTransform', {
          attributeName: 'transform',
          type: 'translate',
          values: '0 0; 0 -0.022; 0 0',
          keyTimes: '0; 0.5; 1',
          dur: '2.4s',
          begin: `${(i * 0.4).toFixed(2)}s`,
          repeatCount: 'indefinite',
          additive: 'sum'
        })
      )
      const t = el('text', {
        'text-anchor': 'middle',
        'dominant-baseline': 'middle',
        'font-family': 'system-ui, sans-serif',
        'font-weight': 700,
        'font-size': z.size,
        fill: COLORS.symbol
      })
      t.textContent = 'Z'
      zz.appendChild(t)
      zOuter.appendChild(zz)
    })
    frameG.appendChild(zOuter)
  }
}

// ------------------------------------------------------------------ 纯函数（几何）

/**
 * 眼皮形状（上/下共用；direction='top' 从上方扫下、'bot' 从下方扫上）。
 * 返回 { move（每帧写 translate 的组）, line（眼睑线 path，写 opacity） }。
 */
function buildLidShape(
  a: FaceAnchor,
  direction: 'top' | 'bot'
): { move: SVGGElement; line: SVGPathElement } {
  const rx = a.rx
  const ry = a.ry
  const sign = direction === 'top' ? 1 : -1 // 1 = 主体在上方；-1 = 主体在下方（镜像）
  const w = 1.35 * rx
  const h = 4 * ry // 主体高度（足够长，扫动全过程不露边）
  // 主体：矩形 + 朝向眼睛的弧（上眼皮下缘 / 下眼皮上缘；控制点下探 LID.edgeDrop*ry）
  const d =
    `M ${(-w).toFixed(4)} ${(-sign * h).toFixed(4)} L ${w.toFixed(4)} ${(-sign * h).toFixed(4)} ` +
    `L ${w.toFixed(4)} 0 Q 0 ${(sign * LID.edgeDrop * ry).toFixed(4)} ${(-w).toFixed(4)} 0 Z`
  // 眼睑线：贴弧、向眼皮内侧收一点（形成"眼皮边缘的柔和线"）
  const dLine =
    `M ${(-1.15 * rx).toFixed(4)} ${(-sign * 0.06 * ry).toFixed(4)} ` +
    `Q 0 ${(sign * 1.05 * ry).toFixed(4)} ${(1.15 * rx).toFixed(4)} ${(-sign * 0.06 * ry).toFixed(4)}`
  const move = el('g')
  move.appendChild(el('path', { d, fill: COLORS.lid }))
  const line = el('path', {
    d: dLine,
    fill: 'none',
    stroke: COLORS.lidLine,
    'stroke-width': 0.0055,
    'stroke-linecap': 'round',
    opacity: 0
  })
  move.appendChild(line)
  move.setAttribute('transform', `translate(0 ${(sign * 2.0 * ry).toFixed(4)})`) // 初始藏于眼外
  return { move, line }
}

/**
 * 眉毛 path（相对眼睛中心；单位 = 世界单位）。
 * - sad：内端高、外端低（八字眉）；
 * - angry：内端低、外端高（倒八字，压向鼻梁）；
 * - raise：整体抬高 + 上凸弧（惊讶挑眉 / thinking 单侧眉）。
 * inward = 朝脸中线方向（左眼 +1、右眼 -1）。
 */
function browD(kind: 'sad' | 'angry' | 'raise', a: FaceAnchor, inward: number): string {
  const rx = a.rx
  const ry = a.ry
  const innerX = BROW.halfLen * rx * inward
  const outerX = -innerX
  if (kind === 'raise') {
    const y = BROW.raiseY * ry
    return (
      `M ${outerX.toFixed(4)} ${(y + 0.18 * ry).toFixed(4)} ` +
      `Q 0 ${(y - 0.22 * ry).toFixed(4)} ${innerX.toFixed(4)} ${(y + 0.18 * ry).toFixed(4)}`
    )
  }
  const yBase = BROW.y * ry
  const innerY = kind === 'sad' ? yBase - BROW.tilt * ry * 0.5 : yBase + BROW.tilt * ry * 0.5
  const outerY = kind === 'sad' ? yBase + BROW.tilt * ry * 0.5 : yBase - BROW.tilt * ry * 0.5
  return `M ${outerX.toFixed(4)} ${outerY.toFixed(4)} L ${innerX.toFixed(4)} ${innerY.toFixed(4)}`
}

/** 注入到 SVG 内部的样式表（只作用于本层；显示规则集中在此，便于调观感） */
function buildCss(): string {
  return `
/* 进入/退出过渡：透明度 + 轻微缩放（缩放围绕自身中心；CSS transform 只用于内层动画组） */
.pfx-fade, .pfx-pop {
  opacity: 0;
  transition: opacity .3s ease, transform .32s cubic-bezier(.34,1.45,.64,1);
}
.pfx-pop { transform-box: fill-box; transform-origin: center; transform: scale(.78); }
.pfx-pop.pfx-symbol { transform-origin: 50% 95%; }
.pfx-blush .pfx-fade { transition: opacity .38s ease; }

/* 眉（形态显隐；.pfx-eyeR 限定 thinking 单侧挑眉） */
[data-emotion="sad"] .pfx-brow-sad { opacity: .92; }
[data-emotion="angry"] .pfx-brow-angry { opacity: .95; }
[data-emotion="surprised"] .pfx-brow-raise { opacity: .92; }
[data-emotion="thinking"] .pfx-eyeR .pfx-brow-raise { opacity: .92; }

/* 泪光 */
[data-emotion="sad"] .pfx-tears { opacity: .95; transform: scale(1); }

/* shy 的 /// */
[data-emotion="shy"] .pfx-squiggle { opacity: .8; transform: scale(1); }

/* surprised：小张嘴 + 瞪眼外圈 */
[data-emotion="surprised"] .pfx-openmouth { opacity: 1; transform: scale(1); }
[data-emotion="surprised"] .pfx-ring { opacity: .75; transform: scale(1); }

/* 头顶符号 */
[data-emotion="thinking"] .pfx-sym-question { opacity: 1; transform: scale(1); }
[data-emotion="angry"] .pfx-sym-anger { opacity: 1; transform: scale(1); }
[data-emotion="sleepy"] .pfx-sym-zzz { opacity: 1; transform: scale(1); }
[data-state="sleeping"] .pfx-sym-zzz { opacity: 1; transform: scale(1); }
`
}
