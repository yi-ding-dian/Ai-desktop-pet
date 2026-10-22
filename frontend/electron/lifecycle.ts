/**
 * 应用退出生命周期标志（2026-10-22）。
 *
 * 背景：退出流程（app.quit → 窗口逐个 close → will-quit）与各域的异步收尾存在竞争：
 * 设置窗关闭会触发"向导回位"、宠物窗关闭会触发球动画收尾——这些流程在退出过程中
 * 再新建魔法球窗口，会把 Electron 的退出卡住（2026-10-22 用户实测：宠物隐藏后点退出，
 * 进程挂起、球窗残留）。
 *
 * 约定：`before-quit` 一触发就置位；此后任何回位/隐藏/显示动画都不得再创建球窗，
 * 只允许瞬时 setBounds/hide。告别演出（quitWithFarewell）在 before-quit 之前运行，不受影响。
 *
 * 本模块不 import electron：ball-animation / settings / main 均可安全引用。
 */
let quitting = false

/** 标记应用正在退出（before-quit 调用；幂等） */
export function markAppQuitting(): void {
  quitting = true
}

/** 应用是否正在退出 */
export function isAppQuitting(): boolean {
  return quitting
}
