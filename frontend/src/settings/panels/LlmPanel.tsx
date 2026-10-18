/**
 * 「LLM」分区（settings 域 panels 层）：服务商 / API 地址 / 模型 / API Key / 测试连接。
 *
 * 交互要点（设计文档 §7.6.2、§7.6.5 首启引导）：
 * - 服务商选择器：推断式受控（不做独立 state，按当前 base_url 反推选中项，
 *   用户手改地址自动落到「自定义」）；选中预设 → 直接覆盖 API 地址 + 模型；
 * - 「去获取 Key ↗」：随预设展示对应官网（本地部署 / 自定义不显示）；
 *   用 `<a target="_blank">`（若主进程后续配 setWindowOpenHandler→openExternal 即走默认浏览器；
 *   当前未配置时由 Electron 默认行为接管），并附 title 完整地址兜底复制；
 * - API Key：只回显服务端掩码（sk-****），点「更新」才出现输入框；输入非空时随保存提交；
 * - 测试连接：test_llm → llm_test_result；成功且 Gateway 支持 /v1/models 时切模型下拉；
 * - 引导模式（guide）：服务商字段高亮提示（"① 选择服务商"）。
 */
import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { Button } from '../../shared/ui'
import Section from '../components/section'
import { Field, SelectField, TextField } from '../components/fields'
import { findProvider, LLM_PROVIDER_PRESETS, matchProviderId } from '../form/llm-providers'
import type { TestResult } from '../hooks/useSettingsController'
import type { PanelProps } from './panel-props'

interface LlmPanelProps extends PanelProps {
  /** 「测试连接」成功拉到的模型列表（null = 尚未拿到，用输入框） */
  models: string[] | null
  testing: boolean
  testResult: TestResult | null
  onTest: () => void
  /** 配置快照版本号：每次服务端 config 事件 +1（保存回执 = 服务端已收到新 key → 收起更新框回到掩码展示） */
  revision: number
  /** 首启引导模式（高亮「服务商」起点） */
  guide: boolean
}

export default function LlmPanel({
  form,
  setField,
  models,
  testing,
  testResult,
  onTest,
  revision,
  guide
}: LlmPanelProps): ReactElement {
  /** Key 的"更新"编辑态（输入新 key）；取消 / 服务端回执后回到掩码展示 */
  const [editingKey, setEditingKey] = useState(false)

  // 配置快照一更新（含保存回执）就收起 Key 更新框：新 key 已交给服务端，掩码是最新权威展示
  useEffect(() => {
    setEditingKey(false)
  }, [revision])

  // ---- 服务商：按 base_url 反推选中项（手改地址 → 自动落「自定义」）
  const providerId = useMemo(() => matchProviderId(form.llmBaseUrl), [form.llmBaseUrl])
  const preset = findProvider(providerId)

  const providerOptions = useMemo(() => {
    const options = LLM_PROVIDER_PRESETS.map((p) => ({ value: p.id, label: p.label }))
    // 未选（地址为空）：显示占位项，避免下拉默认选中第一项造成误解
    return providerId === null ? [{ value: 'none', label: '选择服务商…' }, ...options] : options
  }, [providerId])

  const handleProviderChange = (id: string): void => {
    const picked = findProvider(id)
    if (!picked || picked.id === 'custom') return // 自定义：直接手填下面地址即可（不覆盖现有值）
    // 选中预设：直接覆盖 API 地址与模型（模型字段仍可再改）
    setField('llmBaseUrl', picked.baseUrl)
    setField('llmModel', picked.model)
  }

  // 模型选项：测试成功 → 下拉；当前值不在列表时补一项（避免值丢失）
  const modelOptions = useMemo(() => {
    const base = (models ?? []).map((m) => ({ value: m, label: m }))
    if (form.llmModel && !base.some((o) => o.value === form.llmModel)) {
      return [{ value: form.llmModel, label: `${form.llmModel}（当前）` }, ...base]
    }
    return base
  }, [models, form.llmModel])

  return (
    <Section title="LLM" desc="对话模型（OpenAI 兼容接口）。密钥保存在本机钥匙串，不写入配置文件。">
      <div className={guide ? 'set-guide-focus' : undefined}>
        <Field
          label={guide ? '① 选择服务商' : '服务商'}
          hint={guide ? '选一个服务商，地址与模型会自动填好（本地部署选倒数第二项）' : '换服务商时选择即可（会覆盖 API 地址与模型）'}
        >
          <SelectField
            value={providerId ?? 'none'}
            onValueChange={handleProviderChange}
            options={providerOptions}
          />
        </Field>
      </div>

      <Field label="API 地址" hint="OpenAI 兼容端点，如 https://api.deepseek.com/v1">
        <TextField
          value={form.llmBaseUrl}
          onValueChange={(v) => setField('llmBaseUrl', v)}
          placeholder="https://api.deepseek.com/v1"
        />
      </Field>

      <Field
        label="模型"
        hint={models && models.length > 0 ? '来自「测试连接」拉取的模型列表' : '点「测试连接」成功后，这里会切换为可选的下拉列表'}
      >
        {models && models.length > 0 ? (
          <SelectField value={form.llmModel} onValueChange={(v) => setField('llmModel', v)} options={modelOptions} />
        ) : (
          <TextField
            value={form.llmModel}
            onValueChange={(v) => setField('llmModel', v)}
            placeholder={preset?.modelPlaceholder ?? '如 deepseek-flash'}
          />
        )}
      </Field>

      <Field
        label="API Key"
        hint={
          <>
            留空 = 不修改已保存的 Key；新 Key 保存后立即生效
            {preset?.keyUrl ? (
              <>
                {' · '}
                <a
                  className="set-key-link"
                  href={preset.keyUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  title={`${preset.keyUrl}（若未自动打开，可复制此地址到浏览器访问）`}
                >
                  去获取 Key ↗
                </a>
              </>
            ) : null}
          </>
        }
      >
        {editingKey ? (
          <div className="pui-row">
            <TextField
              type="password"
              value={form.llmKeyInput}
              onValueChange={(v) => setField('llmKeyInput', v)}
              placeholder="输入新的 API Key（sk-…）"
            />
            <Button
              onClick={() => {
                setEditingKey(false)
                setField('llmKeyInput', '')
              }}
            >
              取消
            </Button>
          </div>
        ) : (
          <div className="pui-row">
            <span className="pui-input-static" title="已保存的 Key（掩码展示）">
              {form.llmKeyMasked || '（未配置）'}
            </span>
            <Button
              onClick={() => {
                setEditingKey(true)
                setField('llmKeyInput', '')
              }}
            >
              更新
            </Button>
          </div>
        )}
      </Field>

      <div className="pui-row pui-row-top">
        <Button onClick={onTest} disabled={testing}>
          {testing ? '测试中…' : '测试连接'}
        </Button>
        {testResult ? (
          <span className={`set-test-result ${testResult.ok ? 'ok' : 'fail'}`}>
            {testResult.ok ? '✅ ' : '❌ '}
            {testResult.message}
          </span>
        ) : null}
      </div>
    </Section>
  )
}
