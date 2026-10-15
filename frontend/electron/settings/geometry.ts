/**
 * 设置向导（§7.6.6）几何计算——**纯函数**，不依赖 Electron 运行时。
 *
 * 向导姿态（用户定稿，参考图：截图_选择区域_20261015183330.png）：宠物"扒在设置窗底沿探头"——
 * 头部（耳朵+脸）在设置窗内部的下缘区域、嘴/下巴恰好齐着窗口底边线，身子（脖子以下）垂在
 * 底边线下方、在窗口外露出；水平居中于设置窗。
 * 坐标一律为屏幕 DIP；workArea 由 settings/index.ts 经 screen 查询后传入。
 */
import type { Rect, Size } from '../window'

/**
 * 宠物窗内「嘴/下巴」的视觉 y（px，宠物窗口坐标 0~400）。
 * 标定来源：宠物面 3D 兔子的视觉包围盒（耳顶 y≈8、眼 y≈85~95、嘴 y≈130~145 区间，
 * §7.6.6 定稿量化）；取"嘴压底边线"为基准、区间中部为默认值。
 * **验收时对照参考图微调本值即可**（±10px：调大 → 宠物整体更靠上/头更缩进窗内）。
 */
export const PET_MOUTH_Y = 138

/**
 * 向导位（宠物窗口目标矩形，屏幕坐标）：
 *  - 水平：设置窗横向中心（宠物窗水平居中）——x = 设置窗中心 − 宠物宽/2；
 *  - 垂直：嘴压设置窗底边线——y = 设置窗底边 − PET_MOUTH_Y（上半身叠在设置窗上、
 *    下半身垂出窗外；宠物窗 Z 序在设置窗之上，由窗口置顶属性保证）；
 *  - 约束：宠物窗完全落在工作区内（越界回贴边）——工作区高度不足（常见于设置窗居中时
 *    底边偏低的屏幕）时贴工作区底并允许与设置窗多叠几像素（最少重叠降级，不影响动画）。
 */
export function wizardPetRect(settingsBounds: Rect, petSize: Size, wa: Rect): Rect {
  const w = Math.max(2, Math.round(petSize.width))
  const h = Math.max(2, Math.round(petSize.height))
  let x = Math.round(settingsBounds.x + settingsBounds.width / 2 - w / 2)
  let y = Math.round(settingsBounds.y + settingsBounds.height - PET_MOUTH_Y)
  // 工作区 clamp（窗口大于工作区的极端情形：贴左上，保证可预期）
  x = Math.min(Math.max(x, wa.x), Math.max(wa.x, wa.x + wa.width - w))
  y = Math.min(Math.max(y, wa.y), Math.max(wa.y, wa.y + wa.height - h))
  return { x, y, width: w, height: h }
}
