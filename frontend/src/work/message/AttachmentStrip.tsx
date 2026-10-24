/** 附件条：图片显示缩略图 + 下方文件名，其它显示文件图标 + 文件名。 */
import type { ReactElement } from 'react'
import type { AgentAttachment, PickedFile } from '../../../electron/ipc/channels'

export function attachmentKind(name: string): AgentAttachment['kind'] {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)) return 'image'
  if (
    ['txt', 'md', 'json', 'yaml', 'yml', 'toml', 'csv', 'log', 'ts', 'tsx', 'js', 'jsx', 'py',
      'java', 'go', 'rs', 'c', 'h', 'cpp', 'hpp', 'css', 'html', 'sh', 'ps1', 'bat', 'sql'].includes(ext)
  ) {
    return 'text'
  }
  return 'other'
}

export function fileGlyph(name: string): string {
  const kind = attachmentKind(name)
  return kind === 'image' ? '🖼' : kind === 'text' ? '📄' : '📎'
}

export default function AttachmentStrip({
  files,
  previews,
  onRemove
}: {
  files: PickedFile[]
  previews: Record<string, string>
  onRemove: (path: string) => void
}): ReactElement | null {
  if (files.length === 0) return null
  return (
    <div className="task-attach-strip">
      {files.map((file) => (
        <div className="task-attach" key={file.path} title={file.path}>
          {previews[file.path] ? (
            <img className="task-attach-img" src={previews[file.path]} alt={file.name} />
          ) : (
            <span className="task-attach-icon" aria-hidden="true">
              {fileGlyph(file.name)}
            </span>
          )}
          <span className="task-attach-name">{file.name}</span>
          <button
            type="button"
            className="task-attach-remove"
            aria-label={`移除 ${file.name}`}
            onClick={() => onRemove(file.path)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
