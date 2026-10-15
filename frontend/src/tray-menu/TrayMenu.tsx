/**
 * 自绘托盘菜单（§7.6.4 v2）：替代原生 Menu（系统渲染、样式不可控的面子问题），配色跟随主题。
 *
 * 结构（对齐原托盘菜单，顺序一致）：显示/隐藏宠物（文案由 TRAY_MENU_INIT {petVisible} 驱动，
 * visible → "隐藏宠物"）、教学模式、设置、（分隔）、退出。
 * 交互：点击项 → `trayMenu.action(...)` → 主进程执行动作并收起本窗
 * （失焦自动收起、定位到托盘图标锚点均在主进程，本页不感知）。
 *
 * 容错：bridge 访问一律宽容读取——无 bridge（浏览器直开调试）或旧 preload（无 trayMenu 段）时
 * 渲染静态菜单、点击无害（可选链静默），便于 vite dev 直接打开本页核对样式。
 */
import { useEffect, useState, type ReactElement } from 'react'
import { getPetBridge } from '../shared/pet-bridge'
import type { TrayMenuAction } from '../../electron/ipc/channels'

/** TRAY_MENU_INIT 载荷（契约见 electron/ipc/channels.ts） */
interface TrayMenuInitPayload {
  petVisible: boolean
}

/**
 * trayMenu 段的宽容视图：契约方法 `action` + 初始化订阅 `onInit`。
 * `onInit` 尚不在 PetBridgeApi 类型声明中（preload 侧由并行实现补齐）——以可选方法探测，
 * 未暴露时静默跳过（菜单文案回退默认"隐藏宠物"）。
 */
type TrayMenuBridge = {
  action?: (a: TrayMenuAction) => void
  onInit?: (cb: (payload: TrayMenuInitPayload) => void) => () => void
}

/** 宽容取 trayMenu 段：bridge 缺失（浏览器直开）或段缺失时返回 undefined */
function trayMenuBridge(): TrayMenuBridge | undefined {
  try {
    return (getPetBridge() as { trayMenu?: TrayMenuBridge }).trayMenu
  } catch {
    return undefined
  }
}

export default function TrayMenu(): ReactElement {
  /** 宠物窗口当前是否可见（TRAY_MENU_INIT 驱动第一项文案；默认 true →「隐藏宠物」） */
  const [petVisible, setPetVisible] = useState(true)

  useEffect(() => {
    const off = trayMenuBridge()?.onInit?.((payload) => {
      if (typeof payload?.petVisible === 'boolean') setPetVisible(payload.petVisible)
    })
    return () => off?.()
  }, [])

  const fire = (action: TrayMenuAction): void => {
    if (import.meta.env.DEV) console.log(`[tray-menu] action → ${action}`)
    trayMenuBridge()?.action?.(action)
  }

  return (
    <div className="tray-menu" role="menu" data-testid="tray-menu">
      <button
        type="button"
        role="menuitem"
        className="tray-menu-item"
        data-testid="tray-menu-toggle-pet"
        onClick={() => fire('toggle-pet')}
      >
        {petVisible ? '隐藏宠物' : '显示宠物'}
      </button>
      <button
        type="button"
        role="menuitem"
        className="tray-menu-item"
        data-testid="tray-menu-teaching"
        onClick={() => fire('teaching')}
      >
        教学模式
      </button>
      <button
        type="button"
        role="menuitem"
        className="tray-menu-item"
        data-testid="tray-menu-settings"
        onClick={() => fire('settings')}
      >
        设置
      </button>
      <div className="tray-menu-sep" role="separator" />
      <button
        type="button"
        role="menuitem"
        className="tray-menu-item tray-menu-danger"
        data-testid="tray-menu-quit"
        onClick={() => fire('quit')}
      >
        退出
      </button>
    </div>
  )
}
