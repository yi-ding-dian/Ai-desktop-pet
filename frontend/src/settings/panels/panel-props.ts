/**
 * 分区共用 props（settings 域 panels 层）。
 * 各分区都是受控视图：值从 form 来，改动经 setField 回写（状态归 useSettingsController）。
 */
import type { FormValues } from '../form/config-form'

export interface PanelProps {
  form: FormValues
  setField: <K extends keyof FormValues>(key: K, value: FormValues[K]) => void
}
