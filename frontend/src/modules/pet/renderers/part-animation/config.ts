/**
 * 企鹅「小豆」造型参数（**唯一造型事实来源**）。
 *
 * - 只放"长什么样"：几何位置 / 尺寸 / 配色 / 五官造型；不含任何动画与情绪逻辑。
 * - 调整造型只改本文件；换形象 = 复制一份参数 + 换绘制函数（见 penguin.ts 顶部说明）。
 * - 坐标系：SVG viewBox `0 0 400 400`（方形），显示时按容器尺寸等比缩放；
 *   构图范围约 x 82–318、y 36–358，四周留白用于呼吸/摇摆/弹跳等动画溢出。
 */

/** 左右成对部件的通用形状 */
export interface PairShape {
  /** 相对 400×400 viewBox 的中心坐标 */
  x: number
  y: number
  rx: number
  ry: number
  /** 旋转角度（度，正值为顺时针；0 表示不旋转） */
  rotate?: number
}

export interface PenguinConfig {
  /** viewBox 边长（方形画布） */
  viewBoxSize: number

  /** 身体：整个企鹅是"圆滚一体"造型，身体即头 */
  body: { cx: number; cy: number; rx: number; ry: number }
  /** 肚子：白色前襟椭圆 */
  belly: { cx: number; cy: number; rx: number; ry: number }
  /** 头顶高光：一枚很淡的小椭圆，增加扁平风的层次 */
  headHighlight: { cx: number; cy: number; rx: number; ry: number }

  /** 呆毛（头顶一根卷毛，用描边绘制；弯曲动画绕 root 旋转） */
  hair: {
    path: string
    strokeWidth: number
    rootX: number
    rootY: number
  }

  /** 双翅（鳍）：绕根部旋转做扇动；root 是旋转轴心（身体内侧） */
  wings: {
    left: PairShape & { rootX: number; rootY: number }
    right: PairShape & { rootX: number; rootY: number }
  }

  /** 眼睛（大眼萌：眼白 + 瞳孔 + 高光；另有笑眼弧线与两套眉毛叠层） */
  eyes: {
    left: { cx: number; cy: number }
    right: { cx: number; cy: number }
    /** 眼白椭圆半径（眨眼/半闭通过纵向压缩实现） */
    white: { rx: number; ry: number }
    /** 瞳孔圆半径 + 相对眼中心的默认内偏（左眼向右、右眼向左，显得聚焦） */
    pupil: { r: number; inward: number; down: number }
    /** 瞳孔高光（左上小圆，相对瞳孔中心的偏移） */
    highlight: { r: number; dx: number; dy: number }
    /** 笑眼弧线：相对眼中心的路径（左眼；右眼水平镜像） */
    arcPath: string
    /** 表情眉毛（相对眼中心坐标，左眼；右眼水平镜像） */
    brow: { angryPath: string; sadPath: string; width: number }
  }

  /** 嘴（动态路径：宽度/弯度/开合由动画逐帧计算，见 part-animation/mouth.ts 思路） */
  mouth: {
    cx: number
    cy: number
    /** 中性状态嘴宽（px，viewBox 坐标） */
    baseWidth: number
    /** 全开时的最大张开高度（px） */
    maxOpen: number
  }

  /** 腮红（左右两团，透明度/颜色受情绪驱动） */
  blush: { left: PairShape; right: PairShape }

  /** 双脚（橙色小圆脚，从身体底部伸出） */
  feet: { left: PairShape; right: PairShape }

  /** 摸头反应时飘出的心形粒子（头顶起飞，延迟错开） */
  hearts: {
    /** 以原点为中心的心形 path（绘制时平移到锚点） */
    path: string
    anchors: Array<{ x: number; y: number; delayMs: number; swayPx: number }>
  }

  /** 配色（扁平风：纯色 + 轻渐变；无描边） */
  colors: {
    bodyTop: string
    bodyBottom: string
    bellyTop: string
    bellyBottom: string
    wing: string
    hair: string
    pupil: string
    eyeWhite: string
    mouth: string
    footTop: string
    footBottom: string
    blush: string
    brow: string
  }
}

export const PENGUIN_CONFIG: PenguinConfig = {
  viewBoxSize: 400,

  // 身体：椭圆圆滚一体（宽 236 / 高 252）
  body: { cx: 200, cy: 208, rx: 118, ry: 126 },

  // 肚子：白色前襟，位于身体下半
  belly: { cx: 200, cy: 256, rx: 76, ry: 76 },

  // 头顶高光：左上微光
  headHighlight: { cx: 168, cy: 112, rx: 34, ry: 20 },

  // 呆毛：从头顶向上卷的一根小毛
  hair: {
    path: 'M 202 96 C 198 66 186 52 170 44 C 164 41 166 33 173 35 C 190 40 206 58 212 84',
    strokeWidth: 8,
    rootX: 202,
    rootY: 96
  },

  wings: {
    left: { x: 74, y: 232, rx: 30, ry: 66, rotate: -16, rootX: 96, rootY: 196 },
    right: { x: 326, y: 232, rx: 30, ry: 66, rotate: 16, rootX: 304, rootY: 196 }
  },

  eyes: {
    left: { cx: 152, cy: 152 },
    right: { cx: 248, cy: 152 },
    white: { rx: 25, ry: 28 },
    pupil: { r: 13, inward: 3, down: 3 },
    highlight: { r: 5, dx: -5, dy: -6 },
    // 笑眼：一条上凸的弧（闭眼微笑）
    arcPath: 'M -20 7 Q 0 -15 20 7',
    brow: {
      // 生气：外侧高、内侧低（压向眼睛）
      angryPath: 'M -22 -37 L 16 -23',
      // 难过：内侧高、外侧低（八字眉）
      sadPath: 'M -22 -24 L 16 -37',
      width: 6
    }
  },

  mouth: { cx: 200, cy: 196, baseWidth: 28, maxOpen: 34 },

  blush: {
    left: { x: 120, y: 192, rx: 23, ry: 13, rotate: -8 },
    right: { x: 280, y: 192, rx: 23, ry: 13, rotate: 8 }
  },

  feet: {
    left: { x: 168, y: 344, rx: 30, ry: 14, rotate: -12 },
    right: { x: 232, y: 344, rx: 30, ry: 14, rotate: 12 }
  },

  hearts: {
    // 以原点为中心的心形（宽约 16、高约 13）
    path: 'M 0 5 C -10 -3 -6 -13 0 -7 C 6 -13 10 -3 0 5 Z',
    anchors: [
      { x: 178, y: 60, delayMs: 0, swayPx: -8 },
      { x: 222, y: 52, delayMs: 260, swayPx: 9 }
    ]
  },

  colors: {
    bodyTop: '#4E5F8C',
    bodyBottom: '#2B3556',
    bellyTop: '#F8FAFF',
    bellyBottom: '#E2E9F6',
    wing: '#333E63',
    hair: '#3A466B',
    pupil: '#212842',
    eyeWhite: '#FFFFFF',
    mouth: '#F09A2E',
    footTop: '#F7B733',
    footBottom: '#E8940F',
    blush: '#FF9BAB',
    brow: '#1C2334'
  }
}
