/**
 * 屏幕边缘动作模型常量（2026-10-20）。
 *
 * 三个模型都是独立静态 GLB（无骨骼/动画/形态键），由"窗口贴边"触发接管画面：
 * - left：身体在左、头从屏幕左边探出朝右；
 * - right：上一个的镜像，从屏幕右边探出朝左；
 * - hang：双手抓屏幕顶边、身体悬垂。
 *
 * 定位方式：贴边时把渲染画布（.pet-canvas-mount）整体移到窗口对应边缘（CSS data-edge），
 * 模型再对齐画布边——切面/手正好落在屏幕边上，不依赖窗口吸附。
 */

/** 左探模型（切面对齐画布左边缘） */
export const EDGE_LEFT_MODEL_URL = `${import.meta.env.BASE_URL}models/rabbit-edge-left.glb`

/** 右探模型（切面对齐画布右边缘） */
export const EDGE_RIGHT_MODEL_URL = `${import.meta.env.BASE_URL}models/rabbit-edge-right.glb`

/** 悬挂模型（双手对齐画布上边缘） */
export const EDGE_HANG_MODEL_URL = `${import.meta.env.BASE_URL}models/rabbit-edge-hang.glb`

/**
 * 底部趴睡模型（2026-10-20）：直接复用睡姿模型（无口水，与睡眠状态同一只）。
 * 按站姿宽度 × SLEEP_WIDTH_RATIO 归一化，与真实睡姿的体量一致。
 */
export { SLEEP_MODEL_URL as EDGE_BOTTOM_MODEL_URL } from '../sleep/config'

/** 进入/退出过渡时长（秒）：与睡姿一致，切换不突兀 */
export const EDGE_TRANSITION_SECONDS = 0.36

/** 进入起点缩放（从略小弹到正常） */
export const EDGE_ENTER_SCALE = 0.92

/** 进入起点竖直偏移（世界单位；负 = 略下沉，向上浮入） */
export const EDGE_ENTER_OFFSET_Y = -0.02

/** 探头模型呼吸起伏（世界单位/Hz）：幅度极小，只让画面"活着" */
export const EDGE_BREATHE_AMPLITUDE = 0.0035
export const EDGE_BREATHE_FREQ = 0.55

/**
 * 贴边前表面深度的安全余量（世界单位，2026-10-20）：按模型自身包围盒 z 上限计算
 * 可见范围后，再留 2px 左右，避免抗锯齿/取整把前表面边缘切出 1px 白边。
 */
export const EDGE_DEPTH_SAFETY = 0.02

/**
 * 左右贴边时向屏幕外多送的距离（世界单位，约 6px；2026-10-20）。
 * 透视图里身体切面的前边缘靠外、后边缘靠内；按前边缘贴边仍会看到几像素缝。
 * 让切面前边缘略出屏（裁掉的是平坦的身体切面），后边缘正好落到屏幕边，视觉上贴住。
 * 只用于左右——顶部手/底部脚不能出屏，否则会裁到可见轮廓。
 */
export const EDGE_SIDE_OVERLAP = 0.04
