/**
 * 「记忆本」分区（settings 域 panels 层，2026-10-18）。
 *
 * 作用：把宠物在对话里记住的链接 / 本机文件或文件夹 / 短文本列出来，
 * 支持按类型筛选、打开、改名、删记录，以及把本机路径移入系统回收站。
 *
 * 删除语义（与后端/主进程一致）：
 * - 「只删记录」只移除记忆本条目，**不动磁盘文件**；
 * - 「删除文件（回收站）」走主进程原生确认框，确认后才移入回收站（可恢复）。
 */
import { useMemo, useState, type ReactElement } from 'react'
import { EmptyState, IconButton, Notice } from '../../shared/ui'
import Section from '../components/section'
import { SelectField, TextField } from '../components/fields'
import {
  useNotebookController,
  type NotebookFilter
} from '../hooks/useNotebookController'
import type { NotebookItemData, NotebookKind } from '../../shared/protocol'
import './notebook-panel.css'

const FILTERS: ReadonlyArray<{ id: NotebookFilter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'link', label: '链接' },
  { id: 'path', label: '文件/文件夹' },
  { id: 'text', label: '文字' }
]

const KIND_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: '自动判断' },
  { value: 'link', label: '网页链接' },
  { value: 'path', label: '本机路径' },
  { value: 'text', label: '短文本' }
]

const VALUE_PLACEHOLDER: Record<NotebookKind, string> = {
  link: 'https://example.com',
  path: 'D:\\项目 或 /home/me/项目（必须是绝对路径且存在）',
  text: '要记住的短文本，如快递单号'
}

const AUTO_PLACEHOLDER = '链接 / 绝对路径 / 短文本（自动判断）'

function kindLabel(item: NotebookItemData): string {
  if (item.kind === 'link') return '链接'
  if (item.kind === 'path') return item.is_dir ? '文件夹' : '文件'
  return '文字'
}

function formatTime(ms: number): string {
  if (!ms) return '-'
  try {
    return new Date(ms).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    })
  } catch {
    return '-'
  }
}

export default function NotebookPanel(): ReactElement {
  const ctrl = useNotebookController()
  const [name, setName] = useState('')
  const [kind, setKind] = useState<NotebookKind | ''>('')
  const [value, setValue] = useState('')
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editingName, setEditingName] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null)

  const filteredItems = useMemo(
    () =>
      ctrl.filter === 'all'
        ? ctrl.items
        : ctrl.items.filter((item) => item.kind === ctrl.filter),
    [ctrl.items, ctrl.filter]
  )

  const connected = ctrl.connection === 'connected'
  const canAdd = connected && value.trim().length > 0

  const handleAdd = (): void => {
    if (!canAdd) return
    ctrl.saveItem({
      name: name.trim() || undefined,
      kind: kind || undefined,
      value: value.trim()
    })
    setName('')
    setValue('')
  }

  return (
    <Section
      title="记忆本"
      desc="你说「记住…」时存在这里；打开/删除都按名字取精确值，链接和路径不会被改写。"
    >
      <div className="notebook-toolbar">
        <div className="notebook-filters" role="group" aria-label="按类型筛选">
          {FILTERS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`pui-chip${ctrl.filter === item.id ? ' pui-is-active' : ''}`}
              onClick={() => ctrl.setFilter(item.id)}
            >
              {item.label}
            </button>
          ))}
          <span className="notebook-count">共 {ctrl.count} 条</span>
        </div>
        <button
          type="button"
          className="pui-btn"
          disabled={!connected || ctrl.loading}
          onClick={ctrl.refresh}
        >
          刷新
        </button>
      </div>

      {!connected ? (
        <div className="notebook-hint">
          正在连接后端…（连接后自动读取；也可以先在宠物对话里说“记住…”）
        </div>
      ) : null}

      <div className="notebook-add">
        <TextField
          value={name}
          onValueChange={setName}
          placeholder="名字（可省略，自动起名）"
        />
        <SelectField
          value={kind}
          onValueChange={(next) => setKind(next as NotebookKind | '')}
          options={KIND_OPTIONS}
        />
        <TextField
          value={value}
          onValueChange={setValue}
          placeholder={kind ? VALUE_PLACEHOLDER[kind] : AUTO_PLACEHOLDER}
        />
        <button
          type="button"
          className="pui-btn pui-btn-primary"
          disabled={!canAdd}
          onClick={handleAdd}
        >
          保存
        </button>
      </div>

      {ctrl.notice ? (
        <Notice
          kind={ctrl.notice.kind}
          action={
            <IconButton label="关闭提示" onClick={ctrl.dismissNotice}>
              ×
            </IconButton>
          }
        >
          {ctrl.notice.text}
        </Notice>
      ) : null}

      {ctrl.loading && filteredItems.length === 0 ? (
        <EmptyState title="正在读取记忆本…" />
      ) : filteredItems.length === 0 ? (
        <EmptyState
          title="记忆本里还没有这类条目"
          hint="跟小兔说「记住这个链接叫…」就会出现在这里。"
        />
      ) : (
        <div className="notebook-table-wrap">
          <table className="notebook-table">
            <colgroup>
              <col className="notebook-col-name" />
              <col className="notebook-col-kind" />
              <col />
              <col className="notebook-col-time" />
              <col className="notebook-col-ops" />
            </colgroup>
            <thead>
              <tr>
                <th>名字</th>
                <th>类型</th>
                <th>内容</th>
                <th>更新时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {filteredItems.map((item) => (
                <tr key={item.id}>
                  {editingId === item.id ? (
                    <td colSpan={5}>
                      <div className="notebook-rename">
                        <span className="notebook-rename-label">
                          重命名「{item.name}」
                        </span>
                        <TextField
                          value={editingName}
                          onValueChange={setEditingName}
                        />
                        <button
                          type="button"
                          className="pui-btn pui-btn-sm pui-btn-primary"
                          onClick={() => {
                            ctrl.renameItem(item.name, editingName)
                            setEditingId(null)
                          }}
                        >
                          保存
                        </button>
                        <button
                          type="button"
                          className="pui-btn pui-btn-sm"
                          onClick={() => setEditingId(null)}
                        >
                          取消
                        </button>
                      </div>
                    </td>
                  ) : (
                    <>
                      <td className="notebook-name" title={item.name}>
                        {item.name}
                      </td>
                      <td className="notebook-kind">{kindLabel(item)}</td>
                      <td className="notebook-value" title={item.value}>
                        <div className="notebook-value-line">
                          <span className="notebook-value-text">
                            {item.value}
                          </span>
                          {item.kind === 'path' && !item.path_exists ? (
                            <span className="notebook-warn">
                              ⚠ 路径不存在
                            </span>
                          ) : null}
                        </div>
                      </td>
                      <td className="notebook-time">
                        {formatTime(item.updated_at)}
                      </td>
                      <td className="notebook-ops">
                        <div className="notebook-actions">
                          {item.kind !== 'text' ? (
                            <button
                              type="button"
                              className="pui-btn pui-btn-sm"
                              disabled={
                                item.kind === 'path' && !item.path_exists
                              }
                              onClick={() => ctrl.openItem(item)}
                            >
                              打开
                            </button>
                          ) : null}
                          <button
                            type="button"
                            className="pui-btn pui-btn-sm"
                            onClick={() => {
                              setEditingId(item.id)
                              setEditingName(item.name)
                              setConfirmDeleteId(null)
                            }}
                          >
                            改名
                          </button>
                          <button
                            type="button"
                            className="pui-btn pui-btn-sm pui-btn-danger"
                            onClick={() => {
                              setConfirmDeleteId(item.id)
                              setEditingId(null)
                            }}
                          >
                            删除
                          </button>
                        </div>
                        {confirmDeleteId === item.id ? (
                          <div className="notebook-delete-confirm">
                            <span className="notebook-delete-title">
                              确定要删除吗？
                            </span>
                            {item.kind === 'path' ? (
                              <>
                                <button
                                  type="button"
                                  className="pui-btn pui-btn-sm"
                                  onClick={() => {
                                    ctrl.deleteRecord([item.name])
                                    setConfirmDeleteId(null)
                                  }}
                                >
                                  只删记录
                                </button>
                                <button
                                  type="button"
                                  className="pui-btn pui-btn-sm pui-btn-danger"
                                  onClick={() => {
                                    ctrl.deleteFile(item)
                                    setConfirmDeleteId(null)
                                  }}
                                >
                                  删除文件（回收站）
                                </button>
                              </>
                            ) : (
                              <button
                                type="button"
                                className="pui-btn pui-btn-sm pui-btn-danger"
                                onClick={() => {
                                  ctrl.deleteRecord([item.name])
                                  setConfirmDeleteId(null)
                                }}
                              >
                                删除记录
                              </button>
                            )}
                            <button
                              type="button"
                              className="pui-btn pui-btn-sm"
                              onClick={() => setConfirmDeleteId(null)}
                            >
                              取消
                            </button>
                          </div>
                        ) : null}
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  )
}
