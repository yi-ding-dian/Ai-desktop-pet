/**
 * 「任务」分区（settings 域 panels 层）：任务模式默认工作区。
 *
 * 工作区写入 config.toml `[agent].default_workspace`；主进程经内部端点读取，
 * 任务页每次新任务都从这里开始。留空 = 平台默认（用户文档/ai-desktop-pet）。
 */
import { useEffect, useState, type ReactElement } from 'react'
import { Button } from '../../shared/ui'
import { getPetBridge } from '../../shared/pet-bridge'
import Section from '../components/section'
import { Field, SelectField, SwitchRow, TextField } from '../components/fields'
import type { PanelProps } from './panel-props'

export default function AgentPanel({ form, setField }: PanelProps): ReactElement {
  /** 留空时的实际落点（只取平台默认，不会被已配置值污染） */
  const [fallbackHint, setFallbackHint] = useState('平台默认（用户文档/ai-desktop-pet）')

  useEffect(() => {
    let alive = true
    try {
      void getPetBridge()
        .agent.getPlatformDefaultWorkspace()
        .then((path) => {
          if (alive && path) setFallbackHint(path)
        })
        .catch(() => {
          /* 取不到：保留通用提示 */
        })
    } catch {
      /* 旧 preload：保留通用提示 */
    }
    return () => {
      alive = false
    }
  }, [])

  const browse = async (): Promise<void> => {
    try {
      const picked = await getPetBridge().agent.pickWorkspace()
      if (picked) setField('agentDefaultWorkspace', picked)
    } catch {
      /* 对话框失败时保持原值 */
    }
  }

  return (
    <Section
      title="任务"
      desc="宠物窗带文件的消息会转到任务模式处理；这里设置新任务的默认工作区与任务页顶部显示项。"
    >
      <Field
        label="默认工作区"
        hint={`新任务从这里开始执行。留空 = ${fallbackHint}。目录不存在或无法访问时，任务页会提示重新选择，不会自动换目录。`}
      >
        <div className="pui-row">
          <TextField
            value={form.agentDefaultWorkspace}
            onValueChange={(value) => setField('agentDefaultWorkspace', value)}
            placeholder="留空 = 平台默认"
          />
          <Button onClick={() => void browse()}>选择文件夹…</Button>
        </div>
      </Field>

      <Field
        label="思考强度"
        hint="任务模式每次新任务生效：low 省 token/更快，high 默认，max 适合复杂任务；deepseek-v4-pro 不支持 low，会自动回退 high；对话模式不受影响"
      >
        <SelectField
          value={form.agentThinkingLevel}
          onValueChange={(value) => setField('agentThinkingLevel', value)}
          options={[
            { value: 'low', label: 'low · 省 token' },
            { value: 'high', label: 'high · 默认' },
            { value: 'max', label: 'max · 复杂任务' }
          ]}
        />
      </Field>

      <SwitchRow
        label="显示模型名称"
        hint="在任务页顶部显示当前任务实际使用的模型"
        checked={form.agentShowModel}
        onCheckedChange={(value) => setField('agentShowModel', value)}
      />

      <SwitchRow
        label="显示本次消耗"
        hint="显示当前任务的预估费用（按 DeepSeek 官方价估算，含每轮统计里的费用）"
        checked={form.agentShowCost}
        onCheckedChange={(value) => setField('agentShowCost', value)}
      />

      <SwitchRow
        label="显示账户余额"
        hint="在任务页顶部显示 DeepSeek 账户余额；开启后每 10 分钟查询一次（只支持官方端点）"
        checked={form.agentShowBalance}
        onCheckedChange={(value) => setField('agentShowBalance', value)}
      />
    </Section>
  )
}
