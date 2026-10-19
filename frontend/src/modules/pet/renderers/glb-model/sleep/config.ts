/**
 * 睡姿子模块常量（2026-10-19）。
 *
 * 睡姿模型是独立的静态 GLB（无骨骼/无动画/无 morph），靠：
 * - 双模型切换表现"趴下"；
 * - 顶点着色器在腹部做缓慢隆起，表现呼吸；
 * - DOM 覆盖层显示 Zzz。
 */

/** 浅睡模型（无口水）：进入 sleeping 先显示 */
export const SLEEP_LIGHT_MODEL_URL = `${import.meta.env.BASE_URL}models/rabbit-sleep-light.glb`

/** 深睡模型（有口水）：睡眠达到 DEEP_SLEEP_DELAY_SECONDS 后切换 */
export const SLEEP_DEEP_MODEL_URL = `${import.meta.env.BASE_URL}models/rabbit-sleep-deep.glb`

/** 浅睡 → 深睡的延迟（秒）：选到深睡模型时，口水在这之后淡入 */
export const DEEP_SLEEP_DELAY_SECONDS = 10

/** 每次入睡随机选到深睡模型的概率（0–1） */
export const DEEP_MODEL_PROBABILITY = 0.5

/** 深睡模型口水淡入时长（秒） */
export const DROOL_FADE_SECONDS = 0.8

/** 浅睡模型宽度比例（与深睡一致；画布加宽后 1.75 仍在可见范围内） */
export const SLEEP_WIDTH_RATIO_LIGHT = 1.75
/** 深睡模型宽度比例 */
export const SLEEP_WIDTH_RATIO_DEEP = 1.75

/** 睡姿模型额外抬高（世界单位）：-0.005 时前爪几乎贴住输入框上沿（再近会开始被遮） */
export const SLEEP_LIFT_Y = -0.005

/** 进入/退出睡眠的过渡时长（秒） */
export const SLEEP_TRANSITION_SECONDS = 0.36

/** 过渡起点：睡姿模型缩小比例 / 下沉量（世界单位） */
export const SLEEP_ENTER_SCALE = 0.86
export const SLEEP_ENTER_OFFSET_Y = -0.035

/** 腹部呼吸：周期（秒）与沿法线的隆起幅度（世界单位，约 1.8% 身高） */
export const BREATH_PERIOD_SECONDS = 4.2
export const BREATH_AMPLITUDE = 0.009

/** 腹部权重在世界 Y 轴上的范围（随 SLEEP_LIFT_Y 同步微调） */
export const BREATH_MIN_Y = -0.025
export const BREATH_MAX_Y = 0.215
export const BREATH_FADE_Y = 0.08

/** Zzz 覆盖层锚点（相对渲染容器；贴近睡姿头部右上方，真机再微调） */
export const ZZZ_LEFT_PERCENT = 52
export const ZZZ_TOP_PERCENT = 42
