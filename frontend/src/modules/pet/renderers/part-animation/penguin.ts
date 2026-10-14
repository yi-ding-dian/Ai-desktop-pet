/**
 * 企鹅「小豆」的 SVG 分层绘制（只负责"画出部件"，不做任何动画）。
 *
 * 输入：造型参数（config.ts）；输出：SVG 根元素 + 部件句柄表（PenguinParts）。
 * 动画循环（animator.ts）与逐帧应用（index.ts → applyFrame）通过句柄直接改属性，
 * 部件元素全程复用，不做任何重绘/重建（性能：仅属性变更 + 小型 SVG 重绘）。
 *
 * 换形象（做别的宠物）：复制一份 config + 写一个同构的 build 函数返回同类句柄即可，
 * 渲染器外壳（PartAnimationRenderer）与 React 调用方均无需改动。
 *
 * 图层顺序（从下到上）：呆毛/翅膀/脚（身体下层）→ 身体 → 色偏层 → 肚子 → 头顶高光
 *                     → 眼/嘴 → 腮红 → 心形粒子（最上层）。
 */
import { PENGUIN_CONFIG, type PenguinConfig } from './config'

const SVG_NS = 'http://www.w3.org/2000/svg'

/** 渐变/element id 序号：避免同页面多实例（HMR、未来多宠物）的 id 冲突 */
let instanceSeq = 0

// ------------------------------------------------------------------ DOM 工具

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
  parent?: SVGElement
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v))
  if (parent) parent.appendChild(el)
  return el
}

function setAttrs(el: SVGElement, attrs: Record<string, string | number>): void {
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v))
}

// ------------------------------------------------------------------ 部件句柄

/** 单只眼睛的部件句柄（局部坐标系：原点 = 眼中心；右眼整体镜像，见 buildPenguin） */
export interface EyeParts {
  /** 外层：固定位置/镜像变换 */
  group: SVGGElement
  /** 眨眼压缩组（scaleY） */
  lid: SVGGElement
  /** 圆眼组（眼白+瞳孔+高光；opacity = eyeRound 控制显隐） */
  round: SVGGElement
  /** 瞳孔组（偏移 + 缩放） */
  pupil: SVGGElement
  /** 笑眼弧线（opacity = eyeArc） */
  arc: SVGPathElement
  /** 生气眉（opacity = browAngry） */
  browAngry: SVGPathElement
  /** 难过眉（opacity = browSad） */
  browSad: SVGPathElement
}

/** 企鹅全部部件句柄 */
export interface PenguinParts {
  svg: SVGSVGElement
  /** 根组：呼吸缩放 + 弹跳位移 */
  root: SVGGElement
  /** 倾斜组：身体倾斜 + 待机摇摆（绕脚底轴心） */
  tilt: SVGGElement
  hair: SVGGElement
  wingL: SVGGElement
  wingR: SVGGElement
  body: SVGEllipseElement
  /** 情绪色偏层（与身体同形状，opacity/color 驱动） */
  bodyTint: SVGEllipseElement
  belly: SVGEllipseElement
  headHighlight: SVGEllipseElement
  eyeL: EyeParts
  eyeR: EyeParts
  mouth: SVGPathElement
  blushL: SVGEllipseElement
  blushR: SVGEllipseElement
  footL: SVGGElement
  footR: SVGGElement
  /** 摸头反应的心形粒子（与 config.hearts.anchors 一一对应） */
  hearts: SVGPathElement[]
}

// ------------------------------------------------------------------ 动态形状

/**
 * 生成嘴的路径（每帧随"宽度/弯度/开合"重算）。
 * 形状 = 上边浅弧 + 下边深弧围成的闭合区域：
 * - open≈0 → 一条月牙形嘴线（厚度约 4–6px）；
 * - open 增大 → 中部向下撑开成"张嘴"；
 * - curve>0 嘴角上翘（微笑）/ curve<0 嘴角下垂（难过）。
 */
export function buildMouthPath(
  cx: number,
  cy: number,
  width: number,
  curve: number,
  open: number
): string {
  const hw = Math.max(6, width) / 2
  const lift = -curve * 7 // 嘴角提升量（正=上翘）
  const up = Math.max(3.2, width * 0.12) // 上边厚度（保证深色身体上的可见性）
  const down = 2.2 + open * 34 // 下半张开高度
  const lx = cx - hw
  const rx = cx + hw
  const ly = cy + lift
  const ry = cy + lift
  const topC = cy - up + lift * 0.5
  const botC = cy + down
  return `M ${lx} ${ly} Q ${cx} ${topC} ${rx} ${ry} Q ${cx} ${botC} ${lx} ${ly} Z`
}

// ------------------------------------------------------------------ 绘制

function buildDefs(svg: SVGSVGElement, cfg: PenguinConfig, uid: string): void {
  const defs = svgEl('defs', {}, svg)
  const c = cfg.colors

  const linear = (id: string, from: string, to: string, x2 = '0', y2 = '1'): void => {
    const g = svgEl(
      'linearGradient',
      { id, x1: '0', y1: '0', x2, y2, gradientUnits: 'objectBoundingBox' },
      defs
    )
    svgEl('stop', { offset: '0', 'stop-color': from }, g)
    svgEl('stop', { offset: '1', 'stop-color': to }, g)
  }

  linear(`${uid}-body`, c.bodyTop, c.bodyBottom)
  linear(`${uid}-belly`, c.bellyTop, c.bellyBottom)
  linear(`${uid}-foot`, c.footTop, c.footBottom)
}

/** 构建一只眼睛（局部坐标：原点 = 眼中心；参数取自 config.eyes） */
function buildEye(parent: SVGGElement, cfg: PenguinConfig): EyeParts {
  const e = cfg.eyes
  const group = svgEl('g', {}, parent)
  const lid = svgEl('g', {}, group)

  // 圆眼（眼白 + 瞳孔 + 高光）
  const round = svgEl('g', {}, lid)
  svgEl('ellipse', { 'class': 'pg-eye-white', rx: e.white.rx, ry: e.white.ry, fill: cfg.colors.eyeWhite }, round)
  const pupil = svgEl('g', {}, round)
  svgEl('circle', { 'class': 'pg-pupil', r: e.pupil.r, fill: cfg.colors.pupil }, pupil)
  svgEl(
    'circle',
    {
      'class': 'pg-eye-spark',
      r: e.highlight.r,
      cx: e.highlight.dx,
      cy: e.highlight.dy,
      fill: cfg.colors.eyeWhite,
      opacity: 0.9
    },
    pupil
  )

  // 笑眼弧线
  const arc = svgEl(
    'path',
    {
      d: e.arcPath,
      fill: 'none',
      stroke: cfg.colors.brow,
      'stroke-width': 6,
      'stroke-linecap': 'round',
      opacity: 0
    },
    lid
  )

  // 两套表情眉毛（默认均隐形）
  const browCommon = {
    fill: 'none',
    stroke: cfg.colors.brow,
    'stroke-width': e.brow.width,
    'stroke-linecap': 'round',
    opacity: 0
  }
  const browAngry = svgEl('path', { d: e.brow.angryPath, ...browCommon }, group)
  const browSad = svgEl('path', { d: e.brow.sadPath, ...browCommon }, group)

  return { group, lid, round, pupil, arc, browAngry, browSad }
}

/** 构建完整企鹅 SVG（含 defs 渐变），返回句柄表 */
export function buildPenguin(cfg: PenguinConfig = PENGUIN_CONFIG): PenguinParts {
  const uid = `pg${++instanceSeq}_${Math.random().toString(36).slice(2, 7)}`
  const svg = svgEl('svg', {
    'class': 'pet-svg',
    viewBox: `0 0 ${cfg.viewBoxSize} ${cfg.viewBoxSize}`,
    'aria-hidden': 'true'
  })

  buildDefs(svg, cfg, uid)

  // 呼吸/弹跳根组 → 倾斜组（轴心 = 脚底中心，由 applyFrame 逐帧写入变换）
  const root = svgEl('g', { 'class': 'pg-root' }, svg)
  const tilt = svgEl('g', { 'class': 'pg-tilt' }, root)

  // ---- 身体下层：呆毛 / 翅膀 / 脚 ----
  const hair = svgEl('g', { 'class': 'pg-hair' }, tilt)
  svgEl(
    'path',
    {
      d: cfg.hair.path,
      fill: 'none',
      stroke: cfg.colors.hair,
      'stroke-width': cfg.hair.strokeWidth,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round'
    },
    hair
  )

  const wingL = svgEl('g', { 'class': 'pg-wing' }, tilt)
  svgEl(
    'ellipse',
    {
      cx: cfg.wings.left.x,
      cy: cfg.wings.left.y,
      rx: cfg.wings.left.rx,
      ry: cfg.wings.left.ry,
      fill: cfg.colors.wing,
      transform: `rotate(${cfg.wings.left.rotate ?? 0} ${cfg.wings.left.x} ${cfg.wings.left.y})`
    },
    wingL
  )
  const wingR = svgEl('g', { 'class': 'pg-wing' }, tilt)
  svgEl(
    'ellipse',
    {
      cx: cfg.wings.right.x,
      cy: cfg.wings.right.y,
      rx: cfg.wings.right.rx,
      ry: cfg.wings.right.ry,
      fill: cfg.colors.wing,
      transform: `rotate(${cfg.wings.right.rotate ?? 0} ${cfg.wings.right.x} ${cfg.wings.right.y})`
    },
    wingR
  )

  const foot = (shape: typeof cfg.feet.left): SVGGElement => {
    const g = svgEl('g', { 'class': 'pg-foot' }, tilt)
    svgEl(
      'ellipse',
      {
        cx: shape.x,
        cy: shape.y,
        rx: shape.rx,
        ry: shape.ry,
        fill: `url(#${uid}-foot)`,
        transform: `rotate(${shape.rotate ?? 0} ${shape.x} ${shape.y})`
      },
      g
    )
    return g
  }
  const footL = foot(cfg.feet.left)
  const footR = foot(cfg.feet.right)

  // ---- 身体主体 + 色偏层 + 肚子 + 头顶高光 ----
  const body = svgEl(
    'ellipse',
    { cx: cfg.body.cx, cy: cfg.body.cy, rx: cfg.body.rx, ry: cfg.body.ry, fill: `url(#${uid}-body)` },
    tilt
  )
  const bodyTint = svgEl(
    'ellipse',
    {
      cx: cfg.body.cx,
      cy: cfg.body.cy,
      rx: cfg.body.rx,
      ry: cfg.body.ry,
      fill: cfg.colors.bodyBottom,
      opacity: 0
    },
    tilt
  )
  const belly = svgEl(
    'ellipse',
    {
      cx: cfg.belly.cx,
      cy: cfg.belly.cy,
      rx: cfg.belly.rx,
      ry: cfg.belly.ry,
      fill: `url(#${uid}-belly)`
    },
    tilt
  )
  const headHighlight = svgEl(
    'ellipse',
    {
      cx: cfg.headHighlight.cx,
      cy: cfg.headHighlight.cy,
      rx: cfg.headHighlight.rx,
      ry: cfg.headHighlight.ry,
      fill: cfg.colors.eyeWhite,
      opacity: 0.1
    },
    tilt
  )

  // ---- 脸：眼 + 嘴 ----
  const eyeL = buildEye(tilt, cfg)
  setAttrs(eyeL.group, { transform: `translate(${cfg.eyes.left.cx} ${cfg.eyes.left.cy})` })

  const eyeR = buildEye(tilt, cfg)
  setAttrs(eyeR.group, {
    // 水平镜像：右眼复用左眼的局部坐标（镜像后局部 +x 朝内，与左眼一致）
    transform: `translate(${cfg.eyes.right.cx} ${cfg.eyes.right.cy}) scale(-1 1)`
  })

  const mouth = svgEl(
    'path',
    { 'class': 'pg-mouth', d: '', fill: cfg.colors.mouth, 'stroke-linejoin': 'round' },
    tilt
  )

  // ---- 腮红 ----
  const blush = (shape: typeof cfg.blush.left): SVGEllipseElement =>
    svgEl(
      'ellipse',
      {
        'class': 'pg-blush',
        cx: shape.x,
        cy: shape.y,
        rx: shape.rx,
        ry: shape.ry,
        fill: cfg.colors.blush,
        opacity: 0,
        transform: `rotate(${shape.rotate ?? 0} ${shape.x} ${shape.y})`
      },
      tilt
    )
  const blushL = blush(cfg.blush.left)
  const blushR = blush(cfg.blush.right)

  // ---- 心形粒子（最上层，默认隐形） ----
  const hearts = cfg.hearts.anchors.map((anchor) =>
    svgEl(
      'path',
      {
        'class': 'pg-heart',
        d: cfg.hearts.path,
        fill: '#FF7D96',
        opacity: 0,
        transform: `translate(${anchor.x} ${anchor.y})`
      },
      svg // 挂在 svg 根（不在 tilt/root 内），避免被呼吸/倾斜变换影响
    )
  )

  return {
    svg,
    root,
    tilt,
    hair,
    wingL,
    wingR,
    body,
    bodyTint,
    belly,
    headHighlight,
    eyeL,
    eyeR,
    mouth,
    blushL,
    blushR,
    footL,
    footR,
    hearts
  }
}
