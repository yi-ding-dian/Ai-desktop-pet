/**
 * 情绪占位展示映射。
 *
 * Live2D 未接入前的「最简表现」：情绪 → emoji（气泡 + 顶部状态栏）。
 * 后续接入 Live2D 时，本映射升级为情绪 → 表情/动作（数据放角色包 emotion_map.json，设计文档 §5.3），
 * 本文件保留为兜底与调试视图。
 */
import { EMOTION_VALUES, type Emotion } from '../../shared/protocol'

export const EMOTION_EMOJI: Record<Emotion, string> = {
  neutral: '😐',
  happy: '😊',
  sad: '😔',
  angry: '😠',
  surprised: '😲',
  shy: '😳',
  thinking: '🤔',
  sleepy: '😴'
}

/** 情绪 → 占位 emoji；协议外的未知取值显示 ❓（不崩溃） */
export function emotionEmoji(emotion: string): string {
  return isEmotion(emotion) ? EMOTION_EMOJI[emotion] : '❓'
}

export function isEmotion(value: string): value is Emotion {
  return (EMOTION_VALUES as readonly string[]).includes(value)
}
