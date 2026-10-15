/**
 * 环境上报（设计文档 §4.5.5）：把"引擎决策需要、但只有渲染/主进程才知道"的信息推给后端。
 *
 * 触发时机（任务约定）：
 * - WS 就绪（连接建立/重连后 hello_ack ok）；
 * - 窗口几何变化（主进程 IPC 侧已 debounce ~1s：拖拽/缓动/系统移动统一收口）；
 * - pet_state 变化（对话中引擎静默的旁路信号——引擎不读 chat_pipeline）；
 * - 每 30s 定时（刷新 system_idle_seconds，用户离开/回来判定的时间源）。
 *
 * 每次上报都实时查询几何与系统空闲秒数（不缓存：拖拽后位置随时在变）。
 */
import { getPetBridge } from '../../../shared/pet-bridge'
import type { PetState } from '../../../shared/protocol'
import type { WsClient } from '../../../shared/ws-client'

/** 定时上报间隔（ms）：system_idle_seconds 的时间分辨率 */
const REPORT_INTERVAL_MS = 30_000

/** dev 态日志（转发到主进程日志）；生产构建自动剔除 */
const devLog = (msg: string): void => {
  if (import.meta.env.DEV) console.log(`[pet/behavior] ${msg}`)
}

/**
 * 接线环境上报；返回清理函数（App 卸载/StrictMode 重挂时调用）。
 */
export function setupEnvReporter(client: WsClient): () => void {
  const bridge = getPetBridge()
  /** 渲染侧当前宠物状态（对话链路 thinking/speaking 也经此旁路上报） */
  let petState: PetState = 'idle'

  const report = async (reason: string): Promise<void> => {
    if (client.connectionState !== 'connected') return
    try {
      const [geo, idleSeconds] = await Promise.all([
        bridge.window.getGeometry(),
        bridge.system.getIdleSeconds()
      ])
      const sent = client.send('env_update', {
        work_area: geo.workArea,
        window_pos: geo.pos,
        window_size: geo.size,
        system_idle_seconds: idleSeconds,
        pet_state: petState
      })
      if (sent) {
        devLog(
          `env_update（${reason}）：pos=${geo.pos.x},${geo.pos.y} idle=${idleSeconds}s state=${petState}`
        )
      }
    } catch (err) {
      // 上报是旁路能力：失败只记日志，不影响行为执行与对话
      console.warn('[pet/behavior] env_update 采集失败：', err)
    }
  }

  const offConnection = client.onStateChange((state) => {
    if (state === 'connected') void report('连接就绪')
  })
  const offPetState = client.on('state', ({ state }) => {
    petState = state
    void report(`pet_state=${state}`)
  })
  const offGeometry = bridge.window.onGeometryChanged(() => void report('窗口几何变化'))
  const timer = window.setInterval(() => void report('定时'), REPORT_INTERVAL_MS)

  // 初始化：晚挂载时（HMR/重连）若已连接立即补一次
  if (client.connectionState === 'connected') void report('初始化')

  return () => {
    offConnection()
    offPetState()
    offGeometry()
    clearInterval(timer)
  }
}
