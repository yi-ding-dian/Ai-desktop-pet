/**
 * 兔子「毛绒白兔」3D 模型 v3：造型参数 + Three.js 程序化建模 + 专属逐帧写入。
 *
 * 原型（用户 2026-10-14 换图）：`Downloads/2110367690366390272.png`——**soft 3D 毛绒渲染风**
 * （"给根胡萝卜吃吧"）：
 * - **奶油白暖白毛绒身体**（#F5F0E8 系）：MeshPhysicalMaterial + **sheen 绒毛边缘光** +
 *   浅色"绒毛壳"（BackSide 半透明白壳 = 边缘毛绒光晕）；**无描边**（与 v2 卡通描边风格相反）；
 * - **大而圆的头**（约占一半）+ 两侧**鼓腮**（颊球）；翠绿大眼（草绿虹膜）+ 黑瞳孔 +
 *   上缘大高光 + **眼下卧蚕浅弧**；粉圆三角鼻 + **人字嘴**；自然晕染腮红（三层同心叠加）；
 * - **长兔耳 ×2**（白毛 + 浅粉内耳，微外张，**右耳略外张前倾 = "一耳略弯"**）；
 * - **草绿 V 领小马甲**：包上半身（圆肩），胸前 V 形开口露白（白色 V 片），下缘露白；
 * - 圆胖梨形身体（胸球 + 臀球融合）+ **站立短腿 ×2 + 小圆脚**（拟人化新增）；
 * - 短小双手：**idle = 胸前合十讨食姿态**（原型姿势），走动/其他状态自然垂摆
 *   （由 frame.handsTogether 插值）。
 *
 * 拟人走路（walkStyle = 'human'，弃用蹦跳）：双腿交替迈步（legL/legR 反相）、
 * 双臂与对侧腿同相同步摆、身体随步起伏/侧倾/微前倾、头部稳定微点、耳朵延迟晃动；
 * **步频由窗口实际移动速度驱动**（渲染器外壳读 screenX/screenY 喂入 animator）。
 *
 * 坐标系与层级（同前几版约定；原点 = 脚底，正面 +Z）：
 *   group → root（呼吸/起伏）→ tilt（身体倾斜/前倾）
 *      ├ legRootL/R（髋部轴心）→ 腿 + 脚
 *      ├ 胸球 / 臀球 / 马甲(球带 + V 片) / 小手×2（肩部轴心）/ 尾巴
 *      └ head（原点 = 头中心）→ 头球 / 颊球×2 / 眼×2 / 鼻 / 人字嘴(+口腔) / 腮红×2 / 耳×2
 */
import * as THREE from 'three'
import type {
  Ellipsoid,
  EyeParts3D,
  HeartAnchor3D,
  PetBuildResult3D,
  PetModel3D,
  PetModelMetrics3D,
  PetParts3D,
  Vec3
} from '../config'
import { RABBIT_EMOTION_POSES } from '../emotion-map'
import {
  addFluffShell,
  buildHeartGeometry,
  buildHearts,
  createResourceTracker,
  ellipsoid,
  fluffyMaterial,
  v3
} from './geometry'

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

// ------------------------------------------------------------------ 造型参数

interface Rabbit3DConfig {
  /** 相机与构图（含耳全高约 2.70，站姿 + 长耳需要较远机位） */
  camera: {
    fov: number
    position: Vec3
    lookAt: Vec3
    fallbackSize: number
  }

  /** 头：大圆头（宽 1.00 × 高 0.94）——约占站姿总高一半 */
  head: { scale: Vec3; centerY: number }
  /** 颊球（鼓腮肉感；贴下脸两侧） */
  cheeks: { left: Ellipsoid; right: Ellipsoid }

  /** 梨形身体：胸球（上窄）+ 臀球（下宽）融合 */
  chest: Ellipsoid
  hips: Ellipsoid

  /** 站立短腿（髋部轴心；腿 + 脚随髋摆动） */
  legs: {
    /** 髋部轴心（左右对称，x = ±hx） */
    hip: { x: number; y: number; z: number }
    /** 腿（胶囊：半径 + 长度；几何中心相对髋） */
    thigh: { radius: number; length: number; center: Vec3 }
    /** 脚（椭球；相对髋） */
    foot: { center: Vec3; scale: Vec3 }
    /** 三个小脚趾（小球；原型脚趾外露） */
    toes: { radius: number; offsets: number[]; center: Vec3 }
  }

  /** 马甲：草绿 V 领（圆肩球带包上半身 + 胸前白色 V 领开口片） */
  vest: {
    center: Vec3
    scale: Vec3
    thetaStart: number
    thetaLength: number
    /** 白色 V 领开口片（三角挤出体；位置 + 尺寸 + 俯仰） */
    vPlate: { center: Vec3; width: number; height: number; thickness: number; rotX: number }
  }

  /** 兔耳：单段长椭圆（白毛 + 粉内耳）；左右静息角略不同 → "一耳略弯" */
  ears: {
    root: { x: number; y: number; z: number }
    /** 左右静息外张角（弧度；右耳略外）= "一耳略弯" */
    rootSplayL: number
    rootSplayR: number
    /** 左右静息前后倾（弧度；右耳略前倾） */
    rootBendL: number
    rootBendR: number
    ear: Ellipsoid
    inner: Ellipsoid
    droopAngle: number
    droopSplay: number
    overLiftBack: number
    overLiftStretch: number
    foldAngle: number
    foldInward: number
  }

  headParts: {
    /** 眼睛：翠绿大眼（绿虹膜 → 黑瞳孔 → 上缘大高光 → 右下副高光；眼下卧蚕浅弧） */
    eyes: {
      pos: { x: number; y: number; z: number }
      /** 绿虹膜（白青底圆面；复用 white 语义层，不随注视移动） */
      iris: { rx: number; ry: number; rz: number }
      /** 瞳孔组前移 */
      pupilForward: number
      /** 黑瞳孔（中央略下） */
      pupil: { rx: number; ry: number; rz: number; y: number; z: number }
      /** 上缘大高光 */
      shine: { r: number; x: number; y: number; z: number }
      /** 右下副高光 */
      subShine: { r: number; x: number; y: number; z: number }
      lookRange: { x: number; y: number }
      /** 眯眼笑弧线 */
      arc: { radius: number; tube: number; z: number; yOffset: number }
      /** 眼下卧蚕浅弧（∪；贴眼球下缘，常驻） */
      lowerLid: { radius: number; tube: number; z: number; yOffset: number; span: number }
      /** 细弧眉（仅 angry/sad 显示） */
      brow: { y: number; z: number; radius: number; tube: number; arcSpan: number }
    }
    /** 鼻：粉色圆三角（圆锥压扁，尖朝下） */
    nose: { center: Vec3; radius: number; height: number; squashZ: number }
    /** 人字嘴（顶点在鼻下）+ 张嘴口腔 */
    mouth: {
      line: { halfWidth: number; depth: number; apexY: number; z: number; tube: number; drop: number }
      hole: { x: number; y: number; z: number; rx: number; ry: number; rz: number }
      maxOpenAngle: number
    }
    /** 腮红：三层同心椭球叠加 = 自然晕染（同一材质，叠加强度形成渐变） */
    blush: {
      center: Vec3
      /** 三层半径（大 → 小）+ 共同 z 半轴 */
      layers: Array<{ rx: number; ry: number; rz: number }>
      color: string
      maxOpacity: number
    }
  }

  /** 短小双手：两套静息姿态（A 合十讨食 / B 自然垂侧），由 handsTogether 插值 */
  arms: {
    left: { root: Vec3; restA: { offset: Vec3; rotZ: number }; restB: { offset: Vec3; rotZ: number }; scale: Vec3 }
    right: { root: Vec3; restA: { offset: Vec3; rotZ: number }; restB: { offset: Vec3; rotZ: number }; scale: Vec3 }
  }

  /** 小圆尾巴 */
  tail: { root: Vec3; radius: number; scale: Vec3 }

  hearts: {
    size: number
    anchors: HeartAnchor3D[]
  }

  /** 绒毛壳厚度（世界单位；浅色半透明外扩壳 = 边缘毛绒光晕） */
  fluff: {
    big: number
    small: number
    color: string
    opacity: number
  }

  /** 配色（奶油白 / 草绿 / 粉 三色体系；sheen 绒毛光） */
  colors: {
    body: string
    vest: string
    vestV: string
    earInner: string
    iris: string
    pupil: string
    highlight: string
    arc: string
    brow: string
    nose: string
    mouthLine: string
    mouthHole: string
    lowerLid: string
    blush: string
    sheen: string
    heart: string
  }
}

export const RABBIT_3D_CONFIG: Rabbit3DConfig = {
  camera: {
    fov: 30,
    // 可见纵向范围约 [-0.21, 2.31]（半高 1.26）：兜住全高 2.12（含耳）+ 心形粒子峰值
    position: { x: 0, y: 1.06, z: 4.7 },
    lookAt: { x: 0, y: 1.05, z: 0 },
    fallbackSize: 208
  },

  // 头：额部头球（宽 0.80 × 高 0.72）+ 双侧大颊球 → 宽扁梨形脸（额头 0.80 / 颊外缘 1.24，宽/高 ≈ 1.66）
  head: { scale: { x: 0.42, y: 0.36, z: 0.42 }, centerY: 1.19 },
  // 颊球：贴下脸两侧外扩（原型"腮肉"核心——把下半脸撑得远比额头宽）
  cheeks: {
    left: { center: { x: -0.3, y: -0.2, z: 0.14 }, scale: { x: 0.3, y: 0.25, z: 0.3 } },
    right: { center: { x: 0.3, y: -0.2, z: 0.14 }, scale: { x: 0.3, y: 0.25, z: 0.3 } }
  },

  // 梨形身体（矮胖）：胸球（上窄：宽 0.84）+ 臀球（下宽：宽 1.00，底 0.08）
  chest: { center: { x: 0, y: 0.68, z: 0 }, scale: { x: 0.42, y: 0.26, z: 0.4 } },
  hips: { center: { x: 0, y: 0.42, z: 0 }, scale: { x: 0.5, y: 0.34, z: 0.47 } },

  // 站立短腿：髋轴心 (±0.18, 0.3)；腿胶囊（r 0.085 长 0.1）；小圆脚 + 3 小脚趾（前伸，落地）
  legs: {
    hip: { x: 0.18, y: 0.335, z: 0.01 },
    thigh: { radius: 0.085, length: 0.13, center: { x: 0, y: -0.095, z: 0 } },
    foot: { center: { x: 0, y: -0.245, z: 0.05 }, scale: { x: 0.11, y: 0.075, z: 0.14 } },
    toes: { radius: 0.028, offsets: [-0.07, 0, 0.07], center: { x: 0, y: -0.26, z: 0.17 } }
  },

  // 马甲：草绿球带（与臀球同心外扩 6%——矮胖梨形身体不穿模）包身体中上段（y ≈ 0.30–0.62）
  // + 胸前白色 V 领开口片（肩间大 V，原型特征）
  vest: {
    center: { x: 0, y: 0.42, z: 0 },
    scale: { x: 0.53, y: 0.37, z: 0.5 },
    thetaStart: Math.PI * 0.318,
    thetaLength: Math.PI * 0.287,
    vPlate: { center: { x: 0, y: 0.51, z: 0.53 }, width: 0.36, height: 0.26, thickness: 0.03, rotX: -0.1 }
  },

  ears: {
    // 耳根贴额头两侧（距头心 0.335，头面同 x 处 y ≈ 0.257：从头顶冒出）
    root: { x: 0.28, y: 0.185, z: -0.02 },
    rootSplayL: 0.07, // 左耳较竖直
    rootSplayR: 0.13, // 右耳略外张
    rootBendL: 0.02,
    rootBendR: 0.08, // 右耳略前倾 → "一耳略弯"
    // 单段长椭圆：长 0.74（≈ 0.78 头高，原型比例）、宽 0.24
    ear: { center: { x: 0, y: 0.37, z: 0 }, scale: { x: 0.12, y: 0.37, z: 0.095 } },
    // 浅粉内耳：占耳宽 ~60%，贯穿耳长中部（贴面凸 0.008）
    inner: { center: { x: 0, y: 0.35, z: 0.072 }, scale: { x: 0.062, y: 0.27, z: 0.032 } },
    droopAngle: 0.4,
    droopSplay: 1.05,
    overLiftBack: 0.14,
    overLiftStretch: 0.1,
    foldAngle: 1.05,
    foldInward: 0.5
  },

  headParts: {
    // 眼睛：翠绿大眼（圆：宽 0.254 × 高 0.24）；眼中心距 0.40；位于头心水平（脸中部）
    eyes: {
      pos: { x: 0.2, y: -0.03, z: 0.4 },
      // 绿虹膜（圆面；黑瞳孔与高光可动）
      iris: { rx: 0.132, ry: 0.125, rz: 0.058 },
      pupilForward: 0.03,
      // 黑瞳孔（大：直径约虹膜一半，中央略下）
      pupil: { rx: 0.068, ry: 0.075, rz: 0.034, y: -0.008, z: 0.04 },
      // 上缘大高光（左上）
      shine: { r: 0.046, x: -0.05, y: 0.05, z: 0.048 },
      // 右下副高光
      subShine: { r: 0.021, x: 0.046, y: -0.066, z: 0.042 },
      lookRange: { x: 0.026, y: 0.023 },
      // 眯眼笑弧线（比眼形略宽）
      arc: { radius: 0.135, tube: 0.019, z: 0.075, yOffset: -0.015 },
      // 眼下卧蚕浅弧（∪ 形；常驻、不随眨眼/注视——原型明显特征）
      lowerLid: { radius: 0.11, tube: 0.014, z: 0.022, yOffset: -0.14, span: Math.PI * 0.62 },
      // 细弧眉（仅 angry/sad 显示）
      brow: { y: 0.185, z: 0.05, radius: 0.062, tube: 0.01, arcSpan: Math.PI * 0.72 }
    },

    // 鼻：粉色圆三角（圆锥 16 段压扁，尖朝下）
    nose: { center: { x: 0, y: -0.16, z: 0.4 }, radius: 0.07, height: 0.065, squashZ: 0.45 },
    // 人字嘴：顶点在鼻下（0, apexY）+ 两撇向下分开
    mouth: {
      line: { halfWidth: 0.105, depth: 0.065, apexY: -0.27, z: 0.35, tube: 0.013, drop: 0.018 },
      hole: { x: 0, y: -0.38, z: 0.38, rx: 0.085, ry: 0.062, rz: 0.042 },
      maxOpenAngle: 0.6
    },

    // 腮红：三层同心叠加 = 自然晕染（大而淡 + 中 + 小而浓）
    blush: {
      center: { x: 0.33, y: -0.2, z: 0.42 },
      layers: [
        { rx: 0.19, ry: 0.14, rz: 0.034 },
        { rx: 0.135, ry: 0.1, rz: 0.04 },
        { rx: 0.088, ry: 0.065, rz: 0.045 }
      ],
      color: '#F5A0B5',
      maxOpacity: 0.45
    }
  },

  // 短小双手：A = 胸前合十（idle 讨食）；B = 身侧垂摆（走动/其他）
  arms: {
    left: {
      root: { x: -0.44, y: 0.58, z: 0.12 },
      restA: { offset: { x: 0.35, y: 0.04, z: 0.38 }, rotZ: 0.5 },
      restB: { offset: { x: -0.06, y: -0.22, z: 0.14 }, rotZ: 0.22 },
      scale: { x: 0.11, y: 0.14, z: 0.1 }
    },
    right: {
      root: { x: 0.44, y: 0.58, z: 0.12 },
      restA: { offset: { x: -0.35, y: 0.04, z: 0.38 }, rotZ: -0.5 },
      restB: { offset: { x: 0.06, y: -0.22, z: 0.14 }, rotZ: -0.22 },
      scale: { x: 0.11, y: 0.14, z: 0.1 }
    }
  },

  // 小圆尾巴（臀后 z -0.42 处，露出球帽）
  tail: { root: { x: 0, y: 0.4, z: -0.46 }, radius: 0.115, scale: { x: 1.0, y: 0.95, z: 0.95 } },

  hearts: {
    size: 0.2,
    // 从两耳外侧升起（x ±0.44 避开长耳）
    anchors: [
      { pos: { x: -0.55, y: 1.62, z: 0.16 }, delayMs: 0, sway: 0.1 },
      { pos: { x: 0.58, y: 1.7, z: 0.12 }, delayMs: 240, sway: -0.11 }
    ]
  },

  // 绒毛壳：大件厚一点（边缘毛绒光晕）
  fluff: { big: 0.022, small: 0.015, color: '#FFFDF6', opacity: 0.5 },

  colors: {
    body: '#F7F4EE', // 奶油白（暖白毛绒；比 #F5F0E8 略亮，平光下更接近原型的雪白）
    vest: '#96CB72', // 草绿马甲
    vestV: '#FAF6EE', // V 领开口露白（微暖白，略亮于身体）
    earInner: '#F7C3CE', // 浅粉内耳
    iris: '#55A845', // 翠绿（饱和草绿虹膜）
    pupil: '#26221C', // 黑棕瞳孔
    highlight: '#FFFFFF',
    arc: '#3A332C', // 笑眼弧（毛绒风低对比深棕）
    brow: '#8A7466', // 细眉（低对比暖棕）
    nose: '#F0A0AE', // 粉色圆三角鼻
    mouthLine: '#AD7A6C', // 人字嘴线（暖棕粉细线）
    mouthHole: '#C4767F', // 张嘴口腔（软玫红）
    lowerLid: '#FCF1E2', // 卧蚕浅弧（暖米白，比毛色亮一档、柔和）
    blush: '#F5A0B5', // 晕染腮红
    sheen: '#FFF6EC', // 绒毛边缘光
    heart: '#FF8FA8'
  }
}

// ------------------------------------------------------------------ 专属句柄

/** 单只兔耳骨架（单段长椭圆；左右静息角各有不同 → 一耳略弯） */
export interface EarRig3D {
  root: THREE.Group
  /** 该耳的静息外张/前倾（build 时由左右参数写入） */
  restSplay: number
  restBend: number
}

/** 单条腿句柄（髋部轴心） */
export interface LegRig3D {
  root: THREE.Group
}

/** 兔子专属句柄 */
export interface RabbitParts3D extends PetParts3D {
  earL: EarRig3D
  earR: EarRig3D
  legL: LegRig3D
  legR: LegRig3D
  armL: THREE.Group
  armR: THREE.Group
  tail: THREE.Group
}

// ------------------------------------------------------------------ 建模

export function buildRabbit3D(cfg: Rabbit3DConfig = RABBIT_3D_CONFIG): PetBuildResult3D {
  const tracker = createResourceTracker()
  const { trackG, trackM } = tracker
  const C = cfg.colors
  const sheen = { sheenColor: C.sheen, sheen: 1.0, sheenRoughness: 0.55 }

  // ---------------- 材质（毛绒：MeshPhysicalMaterial + sheen；无塑料高光） ----------------
  const matBody = fluffyMaterial(trackM, C.body, sheen)
  const matVest = fluffyMaterial(trackM, C.vest, { ...sheen, side: THREE.DoubleSide })
  const matVestV = fluffyMaterial(trackM, C.vestV, sheen)
  const matEarInner = fluffyMaterial(trackM, C.earInner, { ...sheen, roughness: 0.95 })
  const matNose = fluffyMaterial(trackM, C.nose, { ...sheen, roughness: 0.75 })
  const matMouthLine = fluffyMaterial(trackM, C.mouthLine, { ...sheen, roughness: 0.85 })
  const matMouthHole = fluffyMaterial(trackM, C.mouthHole, { ...sheen, roughness: 0.9 })
  const matLowerLid = fluffyMaterial(trackM, C.lowerLid, { ...sheen, roughness: 0.95 })
  // 眼部（透明 + 不写深度：opacity 做情绪淡入淡出；瞳孔/高光轻微高光但非塑料）
  const matIris = fluffyMaterial(trackM, C.iris, { ...sheen, roughness: 0.4, transparent: true, depthWrite: false })
  const matPupil = fluffyMaterial(trackM, C.pupil, { ...sheen, roughness: 0.35, transparent: true, depthWrite: false })
  const matHighlight = trackM(new THREE.MeshBasicMaterial({ color: C.highlight, transparent: true, depthWrite: false }))
  const matArc = fluffyMaterial(trackM, C.arc, { ...sheen, transparent: true, depthWrite: false })
  const matBrow = fluffyMaterial(trackM, C.brow, { ...sheen, transparent: true, depthWrite: false })
  // 腮红（三层共享同一材质：叠加产生晕染；opacity 由 applyFrame 驱动）
  const matBlush = fluffyMaterial(trackM, C.blush, {
    ...sheen,
    roughness: 0.95,
    transparent: true,
    depthWrite: false,
    opacity: 0
  })

  // ---------------- 共享几何 ----------------
  const geoSphere = trackG(new THREE.SphereGeometry(1, 40, 28))
  const geoSphereSmall = trackG(new THREE.SphereGeometry(1, 24, 18))
  const geoLeg = trackG(new THREE.CapsuleGeometry(cfg.legs.thigh.radius, cfg.legs.thigh.length, 8, 16))
  const geoVest = trackG(new THREE.SphereGeometry(1, 40, 24, 0, Math.PI * 2, cfg.vest.thetaStart, cfg.vest.thetaLength))
  const geoArc = trackG(new THREE.TorusGeometry(cfg.headParts.eyes.arc.radius, cfg.headParts.eyes.arc.tube, 10, 24, Math.PI))
  // 卧蚕（∪ 弧：弧中点在正下方）
  const geoLowerLid = trackG(
    new THREE.TorusGeometry(
      cfg.headParts.eyes.lowerLid.radius,
      cfg.headParts.eyes.lowerLid.tube,
      8,
      18,
      cfg.headParts.eyes.lowerLid.span
    )
  )
  const geoBrow = trackG(
    new THREE.TorusGeometry(cfg.headParts.eyes.brow.radius, cfg.headParts.eyes.brow.tube, 8, 16, cfg.headParts.eyes.brow.arcSpan)
  )
  // 粉色圆三角鼻（圆锥压扁，尖朝下）
  const geoNose = trackG(new THREE.ConeGeometry(cfg.headParts.nose.radius, cfg.headParts.nose.height, 16))
  // 人字嘴：折线（顶点在鼻下，两撇向下分开）
  const m = cfg.headParts.mouth.line
  const mouthCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-m.halfWidth, m.apexY - m.depth, 0),
    new THREE.Vector3(-m.halfWidth * 0.35, m.apexY - m.depth * 0.42, 0),
    new THREE.Vector3(0, m.apexY, 0),
    new THREE.Vector3(m.halfWidth * 0.35, m.apexY - m.depth * 0.42, 0),
    new THREE.Vector3(m.halfWidth, m.apexY - m.depth, 0)
  ])
  const geoMouthLine = trackG(new THREE.TubeGeometry(mouthCurve, 28, m.tube, 8, false))
  // V 领开口片（圆润倒三角挤出体：白色前胸露肤）
  const vShape = new THREE.Shape()
  const hw = cfg.vest.vPlate.width / 2
  const vh = cfg.vest.vPlate.height
  vShape.moveTo(-hw, 0)
  vShape.quadraticCurveTo(-hw * 0.72, -vh * 0.55, -hw * 0.16, -vh * 0.94)
  vShape.quadraticCurveTo(0, -vh, hw * 0.16, -vh * 0.94)
  vShape.quadraticCurveTo(hw * 0.72, -vh * 0.55, hw, 0)
  vShape.quadraticCurveTo(0, vh * 0.16, -hw, 0)
  const geoVPlate = trackG(
    new THREE.ExtrudeGeometry(vShape, { depth: cfg.vest.vPlate.thickness, bevelEnabled: true, bevelThickness: 0.008, bevelSize: 0.008, bevelSegments: 2, curveSegments: 10 })
  )
  geoVPlate.center()

  // ---------------- 层级 ----------------
  const group = new THREE.Group()
  const root = new THREE.Group()
  const tilt = new THREE.Group()
  group.add(root)
  root.add(tilt)

  // ---- 站立短腿 ×2（髋部轴心：腿 + 脚随髋摆动；绒毛壳） ----
  const buildLeg = (sign: number): LegRig3D => {
    const g = new THREE.Group()
    g.position.set(sign * cfg.legs.hip.x, cfg.legs.hip.y, cfg.legs.hip.z)

    const thigh = new THREE.Mesh(geoLeg, matBody)
    thigh.position.copy(v3(cfg.legs.thigh.center))
    addFluffShell(trackM, thigh, cfg.fluff.small, cfg.fluff.color, cfg.fluff.opacity)
    g.add(thigh)

    const foot = new THREE.Mesh(geoSphereSmall, matBody)
    foot.position.copy(v3(cfg.legs.foot.center))
    foot.scale.copy(v3(cfg.legs.foot.scale))
    addFluffShell(trackM, foot, cfg.fluff.small, cfg.fluff.color, cfg.fluff.opacity)
    g.add(foot)

    // 三个小脚趾（前缘小球——原型脚趾外露）
    for (const ox of cfg.legs.toes.offsets) {
      const toe = new THREE.Mesh(geoSphereSmall, matBody)
      toe.position.set(cfg.legs.toes.center.x + ox, cfg.legs.toes.center.y, cfg.legs.toes.center.z)
      toe.scale.setScalar(cfg.legs.toes.radius)
      g.add(toe)
    }
    return { root: g }
  }
  const legL = buildLeg(-1)
  const legR = buildLeg(1)
  tilt.add(legL.root, legR.root)

  // ---- 梨形身体（胸球 + 臀球；绒毛壳） ----
  const chest = ellipsoid(geoSphere, matBody, cfg.chest)
  addFluffShell(trackM, chest, cfg.fluff.big, cfg.fluff.color, cfg.fluff.opacity)
  const hips = ellipsoid(geoSphere, matBody, cfg.hips)
  addFluffShell(trackM, hips, cfg.fluff.big, cfg.fluff.color, cfg.fluff.opacity)
  tilt.add(chest, hips)

  // ---- 马甲：草绿球带（包上半身）+ 胸前白色 V 领开口片 ----
  const vest = new THREE.Mesh(geoVest, matVest)
  vest.position.copy(v3(cfg.vest.center))
  vest.scale.copy(v3(cfg.vest.scale))
  addFluffShell(trackM, vest, cfg.fluff.small, cfg.fluff.color, cfg.fluff.opacity)
  tilt.add(vest)
  const vPlate = new THREE.Mesh(geoVPlate, matVestV)
  vPlate.position.copy(v3(cfg.vest.vPlate.center))
  vPlate.rotation.x = cfg.vest.vPlate.rotX
  tilt.add(vPlate)

  // ---- 短小双手（肩部轴心；静息姿态由 applyExtras 在 A/B 间插值；绒毛壳） ----
  const buildArm = (a: Rabbit3DConfig['arms']['left']): THREE.Group => {
    const g = new THREE.Group()
    g.position.copy(v3(a.root))
    const mesh = new THREE.Mesh(geoSphere, matBody)
    mesh.scale.copy(v3(a.scale))
    mesh.position.copy(v3(a.restA.offset)) // 初值（每帧由 applyExtras 插值重写）
    addFluffShell(trackM, mesh, cfg.fluff.small, cfg.fluff.color, cfg.fluff.opacity)
    g.add(mesh)
    g.userData.handMesh = mesh
    return g
  }
  const armL = buildArm(cfg.arms.left)
  const armR = buildArm(cfg.arms.right)
  tilt.add(armL, armR)

  // ---- 小圆尾巴 ----
  const tail = new THREE.Group()
  tail.position.copy(v3(cfg.tail.root))
  const tailBall = new THREE.Mesh(geoSphereSmall, matBody)
  tailBall.scale.setScalar(cfg.tail.radius).multiply(v3(cfg.tail.scale))
  addFluffShell(trackM, tailBall, cfg.fluff.small, cfg.fluff.color, cfg.fluff.opacity)
  tail.add(tailBall)
  tilt.add(tail)

  // ---- 头（大圆头 + 颊球 ×2） ----
  const head = new THREE.Group()
  head.position.y = cfg.head.centerY
  tilt.add(head)

  const headBall = new THREE.Mesh(geoSphere, matBody)
  headBall.scale.copy(v3(cfg.head.scale))
  addFluffShell(trackM, headBall, cfg.fluff.big, cfg.fluff.color, cfg.fluff.opacity)
  head.add(headBall)

  // 颊球（鼓腮：贴下脸两侧偏前，与头球融合）
  for (const cheekCfg of [cfg.cheeks.left, cfg.cheeks.right]) {
    const cheek = ellipsoid(geoSphere, matBody, cheekCfg)
    addFluffShell(trackM, cheek, cfg.fluff.big, cfg.fluff.color, cfg.fluff.opacity)
    head.add(cheek)
  }

  // ---- 兔耳（单段长椭圆；左右静息角不同 = "一耳略弯"） ----
  const buildEar = (sign: number, restSplay: number, restBend: number): EarRig3D => {
    const E = cfg.ears
    const g = new THREE.Group()
    g.position.set(sign * E.root.x, E.root.y, E.root.z)
    g.rotation.z = -sign * restSplay
    g.rotation.x = restBend

    const ear = ellipsoid(geoSphere, matBody, E.ear)
    addFluffShell(trackM, ear, cfg.fluff.small, cfg.fluff.color, cfg.fluff.opacity)
    const inner = ellipsoid(geoSphereSmall, matEarInner, E.inner)
    g.add(ear, inner)
    return { root: g, restSplay, restBend }
  }
  const earR = buildEar(1, cfg.ears.rootSplayR, cfg.ears.rootBendR)
  const earL = buildEar(-1, cfg.ears.rootSplayL, cfg.ears.rootBendL)
  head.add(earL.root, earR.root)

  // ---- 眼睛（翠绿大眼 + 黑瞳孔 + 大高光 + 卧蚕） ----
  const buildEye = (xSign: number): EyeParts3D => {
    const e = cfg.headParts.eyes
    const g = new THREE.Group()
    g.position.set(xSign * e.pos.x, e.pos.y, e.pos.z)

    const round = new THREE.Group()
    const iris = new THREE.Mesh(geoSphereSmall, matIris)
    iris.scale.set(e.iris.rx, e.iris.ry, e.iris.rz)
    round.add(iris)

    const pupil = new THREE.Group()
    pupil.position.z = e.pupilForward
    const pupilMesh = new THREE.Mesh(geoSphereSmall, matPupil)
    pupilMesh.position.set(0, e.pupil.y, e.pupil.z)
    pupilMesh.scale.set(e.pupil.rx, e.pupil.ry, e.pupil.rz)
    pupil.add(pupilMesh)
    const shine = new THREE.Mesh(geoSphereSmall, matHighlight)
    shine.position.set(e.shine.x, e.shine.y, e.shine.z)
    shine.scale.setScalar(e.shine.r)
    pupil.add(shine)
    const subShine = new THREE.Mesh(geoSphereSmall, matHighlight)
    subShine.position.set(e.subShine.x, e.subShine.y, e.subShine.z)
    subShine.scale.setScalar(e.subShine.r)
    pupil.add(subShine)
    round.add(pupil)

    // 卧蚕（∪ 弧；常驻，不随眨眼/注视——放眼睛组直级）
    const lowerLid = new THREE.Mesh(geoLowerLid, matLowerLid)
    lowerLid.position.set(0, e.lowerLid.yOffset, e.lowerLid.z)
    lowerLid.rotation.z = -Math.PI / 2 - e.lowerLid.span / 2 // 弧中点在正下方
    g.add(lowerLid)

    // 眯眼笑弧线（∩）
    const arc = new THREE.Mesh(geoArc, matArc)
    arc.position.set(0, e.arc.yOffset, e.arc.z)
    arc.rotation.z = xSign * -0.1
    arc.visible = false

    // 细弧眉
    const brow = new THREE.Group()
    brow.position.set(0, e.brow.y, e.brow.z)
    const browMesh = new THREE.Mesh(geoBrow, matBrow)
    browMesh.rotation.z = Math.PI / 2 - (e.brow.arcSpan / 2 - Math.PI / 2)
    brow.add(browMesh)
    brow.visible = false

    g.add(round, arc, brow)
    return {
      group: g,
      round,
      pupil,
      arc,
      brow,
      roundMaterials: { white: matIris, pupil: matPupil, highlight: matHighlight },
      arcMaterial: matArc,
      browMaterial: matBrow,
      browParams: { baseY: e.brow.y, angryAngle: 0.5, sadLift: 0.06 }
    }
  }
  const eyeL = buildEye(-1)
  const eyeR = buildEye(1)
  head.add(eyeL.group, eyeR.group)

  // ---- 鼻（粉色圆三角，尖朝下） ----
  const nose = new THREE.Mesh(geoNose, matNose)
  nose.position.copy(v3(cfg.headParts.nose.center))
  nose.rotation.z = Math.PI // 尖朝下
  nose.scale.set(1, 1, cfg.headParts.nose.squashZ)
  head.add(nose)

  // ---- 人字嘴 + 口腔 ----
  const mouthLineGroup = new THREE.Group()
  mouthLineGroup.position.set(0, 0, m.z)
  const mouthLineMesh = new THREE.Mesh(geoMouthLine, matMouthLine)
  mouthLineGroup.add(mouthLineMesh)
  head.add(mouthLineGroup)

  const mouthHoleGroup = new THREE.Group()
  mouthHoleGroup.position.set(0, cfg.headParts.mouth.hole.y, cfg.headParts.mouth.hole.z)
  const mouthHole = new THREE.Mesh(geoSphereSmall, matMouthHole)
  mouthHole.scale.set(cfg.headParts.mouth.hole.rx, cfg.headParts.mouth.hole.ry, cfg.headParts.mouth.hole.rz)
  mouthHole.visible = false
  mouthHoleGroup.add(mouthHole)
  head.add(mouthHoleGroup)

  // ---- 腮红（三层同心叠加 = 自然晕染；共享材质） ----
  const buildBlush = (xSign: number): THREE.Mesh => {
    const bl = cfg.headParts.blush
    // 最外层为主 mesh（parts 引用），另两层为子件（同中心、不同尺寸）
    const first = bl.layers[0]
    const base = new THREE.Mesh(geoSphereSmall, matBlush)
    base.position.copy(v3(bl.center))
    base.position.x *= xSign
    base.scale.set(first.rx, first.ry, first.rz)
    for (let i = 1; i < bl.layers.length; i++) {
      const l = bl.layers[i]
      const layer = new THREE.Mesh(geoSphereSmall, matBlush)
      layer.scale.set(l.rx / first.rx, l.ry / first.ry, l.rz / first.rz) // 子件相对父缩放
      base.add(layer)
    }
    return base
  }
  const blushL = buildBlush(-1)
  const blushR = buildBlush(1)
  head.add(blushL, blushR)

  // ---- 心形粒子 ----
  const geoHeart = trackG(buildHeartGeometry(cfg.hearts.size))
  const { hearts, heartMaterials } = buildHearts(trackM, geoHeart, cfg.hearts.anchors, C.heart, group, (tm, color) =>
    tm(
      new THREE.MeshPhysicalMaterial({
        color,
        emissive: new THREE.Color(color),
        emissiveIntensity: 0.35,
        sheen: 0.6,
        sheenColor: new THREE.Color('#FFE9F0'),
        roughness: 0.5,
        transparent: true,
        depthWrite: false,
        opacity: 0
      })
    )
  )

  const handMeshes = {
    left: armL.userData.handMesh as THREE.Mesh,
    right: armR.userData.handMesh as THREE.Mesh
  }

  const parts: RabbitParts3D = {
    group,
    root,
    tilt,
    head,
    eyeL,
    eyeR,
    eyePupilForward: cfg.headParts.eyes.pupilForward,
    mouth: {
      upper: mouthLineGroup,
      lower: mouthHoleGroup,
      upperRest: 0,
      lowerRest: 0,
      maxOpenAngle: cfg.headParts.mouth.maxOpenAngle
    },
    blushL,
    blushR,
    blushMaterial: matBlush,
    blushMaxOpacity: cfg.headParts.blush.maxOpacity,
    hearts,
    heartMaterials,
    heartAnchors: cfg.hearts.anchors,
    bodyMaterial: matBody,
    bodyBaseColor: C.body,
    earL,
    earR,
    legL,
    legR,
    armL,
    armR,
    tail,
    dispose(): void {
      tracker.disposeAll()
    }
  }

  const E = cfg.ears
  /** 单耳逐帧换算（用该耳自己的静息角 → 一耳略弯的不对称保持） */
  const applyEar = (
    rig: EarRig3D,
    sign: number,
    fr: { lift: number; splay: number; back: number; fold: number },
    shake: number
  ): void => {
    const lift = clamp(fr.lift, 0, 1.15)
    const over = Math.max(0, lift - 1)
    const droop = 1 - Math.min(1, lift)
    rig.root.rotation.z = -sign * (rig.restSplay + fr.splay + droop * E.droopSplay + fr.fold * E.foldInward) - sign * shake * 0.7
    rig.root.rotation.x =
      rig.restBend - fr.back + droop * E.droopAngle - over * E.overLiftBack + fr.fold * E.foldAngle * 0.6 + shake * 0.5
    rig.root.scale.y = 1 + over * E.overLiftStretch
  }

  /** 手姿态：A（合十）↔ B（垂侧）按 handsTogether 插值（位置 + 手腕角） */
  const applyArm = (
    arm: THREE.Group,
    hand: THREE.Mesh,
    a: Rabbit3DConfig['arms']['left'],
    sign: number,
    handsTogether: number,
    swing: number
  ): void => {
    const k = clamp(handsTogether, 0, 1)
    const ox = a.restA.offset.x * k + a.restB.offset.x * (1 - k)
    const oy = a.restA.offset.y * k + a.restB.offset.y * (1 - k)
    const oz = a.restA.offset.z * k + a.restB.offset.z * (1 - k)
    hand.position.set(ox, oy, oz)
    arm.rotation.z = (a.restA.rotZ * k + a.restB.rotZ * (1 - k)) * sign
    arm.rotation.x = swing
  }

  return {
    parts,
    /** 兔子专属逐帧：耳 ×2 + 拟人双腿 + 双手（合十/垂摆 + 反相摆臂）+ 尾巴 + 人字嘴/口腔 */
    applyExtras(frame): void {
      applyEar(earL, -1, frame.earL, frame.earShake)
      applyEar(earR, 1, frame.earR, frame.earShake)
      // 拟人双腿：legL/legR 正 = 前摆；绕 x 轴正方向会让腿端向 -z（后），取负号。
      // 前摆时顺带"抬脚"（离地抬升）——短腿在身体下缘遮挡下也读得出迈步
      legL.root.rotation.x = -frame.legL
      legL.root.position.y = cfg.legs.hip.y + Math.max(0, frame.legL) * 0.09
      legR.root.rotation.x = -frame.legR
      legR.root.position.y = cfg.legs.hip.y + Math.max(0, frame.legR) * 0.09
      // 双手：合十 ↔ 垂摆插值 + 前后摆（拟人：与对侧腿同相）
      applyArm(armL, handMeshes.left, cfg.arms.left, 1, frame.handsTogether, frame.wingSwingL) // 左臂 rotZ 正为向外（左手 root 在 -x）
      applyArm(armR, handMeshes.right, cfg.arms.right, 1, frame.handsTogether, frame.wingSwingR)
      // 尾巴：左右轻摆
      tail.rotation.y = frame.tailWag
      // 口型：人字嘴随开口微降 + 口腔缩放（小 scale 藏进头内不可见）
      const mo = clamp(frame.mouthOpen, 0, 1)
      mouthLineGroup.position.y = -m.drop * mo
      const s = 0.02 + 0.98 * mo
      mouthHole.scale.set(cfg.headParts.mouth.hole.rx * s, cfg.headParts.mouth.hole.ry * s, cfg.headParts.mouth.hole.rz)
      mouthHole.visible = mo > 0.05
    }
  }
}

/** animator 需要的度量：相机 + 注视范围 + 心形锚点 */
export const RABBIT_3D_METRICS: PetModelMetrics3D = {
  camera: RABBIT_3D_CONFIG.camera,
  eyeLookRange: {
    x: RABBIT_3D_CONFIG.headParts.eyes.lookRange.x,
    y: RABBIT_3D_CONFIG.headParts.eyes.lookRange.y
  },
  heartAnchors: RABBIT_3D_CONFIG.hearts.anchors
}

/** 模型对象（注册表 models/index.ts 使用）；渲染风格 = soft 3D 毛绒；走路 = 拟人步态 */
export const RABBIT_3D_MODEL: PetModel3D = {
  id: 'rabbit',
  label: '兔子「毛绒白兔」3D',
  walkStyle: 'human',
  style: 'fluffy',
  metrics: RABBIT_3D_METRICS,
  poses: RABBIT_EMOTION_POSES,
  build: () => buildRabbit3D(RABBIT_3D_CONFIG)
}
