/**
 * 设置页主组件（settings 域）：左侧分区导航 + 右侧分区视图 + 底部保存条。
 *
 * 九个分区（设计文档 §7.6.1）：LLM / 文件 / 宠物 / 声音 / 行为 / 记忆 / 记忆本 / 主题 / 关于。
 * 数据流与全部状态在 useSettingsController（唯一控制器）；本文件只做布局、分区切换与状态文案。
 * 「记忆本」面板自带 WS 连接与数据流（useNotebookController），不混入配置保存状态。
 */
import { useEffect, useState, type ReactElement } from 'react'
import { useSettingsController, type SettingsController } from './hooks/useSettingsController'
import LlmPanel from './panels/LlmPanel'
import FilePanel from './panels/FilePanel'
import PetPanel from './panels/PetPanel'
import VoicePanel from './panels/VoicePanel'
import BehaviorPanel from './panels/BehaviorPanel'
import MemoryPanel from './panels/MemoryPanel'
import NotebookPanel from './panels/NotebookPanel'
import ThemePanel from './panels/ThemePanel'
import AboutPanel from './panels/AboutPanel'

type PanelId =
  | 'llm'
  | 'files'
  | 'pet'
  | 'voice'
  | 'behavior'
  | 'memory'
  | 'notebook'
  | 'theme'
  | 'about'

const PANELS: ReadonlyArray<{ id: PanelId; label: string }> = [
  { id: 'llm', label: 'LLM' },
  { id: 'files', label: '文件' },
  { id: 'pet', label: '宠物' },
  { id: 'voice', label: '声音' },
  { id: 'behavior', label: '行为' },
  { id: 'memory', label: '记忆' },
  { id: 'notebook', label: '记忆本' },
  { id: 'theme', label: '主题' },
  { id: 'about', label: '关于' }
]

/** WS 连接状态 → 中文（底部状态文案用） */
const CONNECTION_LABEL: Record<string, string> = {
  idle: '等待后端连接…',
  connecting: '连接中…',
  authenticating: '鉴权中…',
  connected: '已连接',
  reconnecting: '连接断开，重连中…',
  'auth-failed': '鉴权失败（重启应用试试）',
  closed: '已断开'
}

/** 底部状态文案：操作反馈（notice）优先，其次进行中状态，最后连接/同步状态 */
function statusOf(ctrl: SettingsController): { kind: 'info' | 'success' | 'error'; text: string } {
  if (ctrl.notice) return ctrl.notice
  if (ctrl.saving) return { kind: 'info', text: '保存中…' }
  if (ctrl.loadPhase === 'loading') return { kind: 'info', text: '正在读取配置…' }
  if (ctrl.connection !== 'connected') {
    return { kind: 'info', text: CONNECTION_LABEL[ctrl.connection] ?? ctrl.connection }
  }
  if (ctrl.dirty) return { kind: 'info', text: '有未保存的改动' }
  return { kind: 'info', text: '已连接 · 配置已同步' }
}

export default function SettingsApp(): ReactElement {
  const ctrl = useSettingsController()
  const [tab, setTab] = useState<PanelId>('llm')

  // 首启引导（§7.6.5）：进入引导模式时自动切到 LLM 分区（用户随后手动切走不强行拉回——依赖只在 guideMode 变化时触发）
  useEffect(() => {
    if (ctrl.guideMode) setTab('llm')
  }, [ctrl.guideMode])

  const panel = ((): ReactElement => {
    switch (tab) {
      case 'llm':
        return (
          <LlmPanel
            form={ctrl.form}
            setField={ctrl.setField}
            models={ctrl.models}
            testing={ctrl.testing}
            testResult={ctrl.testResult}
            onTest={ctrl.testConnection}
            revision={ctrl.revision}
            guide={ctrl.guideMode}
          />
        )
      case 'files':
        return (
          <FilePanel
            form={ctrl.form}
            setField={ctrl.setField}
            fileMaxCharsError={ctrl.fileMaxCharsError}
            contextTokensError={ctrl.contextTokensError}
          />
        )
      case 'pet':
        return (
          <PetPanel
            form={ctrl.form}
            setField={ctrl.setField}
            bubbleIdleError={ctrl.bubbleIdleError}
          />
        )
      case 'voice':
        return <VoicePanel form={ctrl.form} setField={ctrl.setField} />
      case 'behavior':
        return (
          <BehaviorPanel
            form={ctrl.form}
            setField={ctrl.setField}
            quietHoursError={ctrl.quietHoursError}
          />
        )
      case 'memory':
        return <MemoryPanel form={ctrl.form} setField={ctrl.setField} />
      case 'notebook':
        return <NotebookPanel />
      case 'theme':
        return <ThemePanel />
      case 'about':
        return <AboutPanel appVersion={ctrl.appVersion} onRestart={ctrl.restartApp} />
    }
  })()

  const status = statusOf(ctrl)
  const canSave = ctrl.dirty && !ctrl.saving && ctrl.connection === 'connected'

  return (
    <div className="settings-root">
      {ctrl.guideMode ? (
        <div className="set-welcome" data-testid="guide-welcome">
          <span className="set-welcome-text">
            {ctrl.guideDone
              ? '✅ 配好啦！可以开始聊天了'
              : '👋 最后一步：给我的大脑接个线——选个服务商，填上 API Key 就能聊啦'}
          </span>
          {ctrl.guideDone ? (
            <button
              type="button"
              className="set-welcome-close"
              aria-label="关闭引导提示"
              onClick={ctrl.dismissGuide}
            >
              ×
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="settings-main">
        <nav className="settings-nav" aria-label="设置分区">
          <div className="settings-nav-title">设置</div>
          {PANELS.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`settings-nav-item${tab === p.id ? ' active' : ''}`}
              aria-current={tab === p.id ? 'page' : undefined}
              onClick={() => setTab(p.id)}
            >
              {p.label}
            </button>
          ))}
        </nav>
        <div className="settings-content" data-testid="settings-content">
          {panel}
        </div>
      </div>
      <footer className="settings-footer">
        <span className={`set-status set-status-${status.kind}`} data-testid="settings-status">
          {status.text}
        </span>
        <button
          type="button"
          className="set-btn-primary"
          data-testid="settings-save"
          disabled={!canSave}
          onClick={ctrl.save}
        >
          {ctrl.saving ? '保存中…' : '保存'}
        </button>
      </footer>
    </div>
  )
}
