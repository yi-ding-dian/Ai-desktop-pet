/**
 * 回复气泡设置跨窗口同步（settings 窗 → 宠物窗）。
 *
 * 值的事实来源是后端 config（pet.bubble_idle_seconds，随设置页「保存」落盘）；
 * 但设置窗和宠物窗是两条独立 WS 连接，宠物窗不会自动收到另一个连接的 config 回执。
 * 所以设置窗在拿到配置快照（加载/保存）后，用 BroadcastChannel 把**同一个值**广播给
 * 宠物窗，宠物窗再经 preload 同步给气泡主进程——保存即生效，无需重启。
 *
 * 同源窗口共享 BroadcastChannel（主题的跨窗同步同款机制）。
 */
const CHANNEL_NAME = 'pet-bubble-settings'

let channel: BroadcastChannel | null | undefined

function getChannel(): BroadcastChannel | null {
  if (channel !== undefined) return channel
  try {
    channel = new BroadcastChannel(CHANNEL_NAME)
  } catch {
    channel = null
  }
  return channel
}

/** 广播气泡空闲收起时长（秒）；0 = 不自动收起。 */
export function broadcastBubbleIdleSeconds(seconds: number): void {
  if (!Number.isFinite(seconds)) return
  const ch = getChannel()
  if (!ch) return
  try {
    ch.postMessage({ type: 'bubble-idle-seconds', seconds })
  } catch {
    /* 窗口关闭/通道不可用：静默（宠物窗启动时仍会从 WS config 读一次） */
  }
}

/** 订阅气泡空闲收起时长（宠物窗）；返回取消订阅函数。 */
export function subscribeBubbleIdleSeconds(
  listener: (seconds: number) => void
): () => void {
  const ch = getChannel()
  if (!ch) return () => {}
  const onMessage = (event: MessageEvent): void => {
    const data = event.data as { type?: unknown; seconds?: unknown } | null
    if (data?.type !== 'bubble-idle-seconds') return
    const seconds = Number(data.seconds)
    if (Number.isFinite(seconds)) listener(seconds)
  }
  ch.addEventListener('message', onMessage)
  return () => ch.removeEventListener('message', onMessage)
}
