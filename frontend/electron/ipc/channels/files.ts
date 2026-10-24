/**
 * 用户选中的文件（文件分析 P1）。
 * 只在主进程 stat 元信息，不读正文；正文由本地后端按路径读取并执行限额。
 */
export interface PickedFile {
  /** 绝对路径（仅本地使用：不进提示词、不写日志） */
  path: string
  /** basename（展示/落库用） */
  name: string
  /** 字节数（展示用；后端仍会重新校验） */
  size: number
}
