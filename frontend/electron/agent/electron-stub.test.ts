/**
 * 离线集成自测用的 electron 替身（只在 esbuild --alias 时生效，应用构建不会引用）。
 *
 * 任务恢复测试需要跑 service.ts，但它经 store.ts 用 app.getPath('userData')。
 * 这里把 userData 指向测试临时目录，其余能力保持最小实现。
 */
export const app = {
  getPath: (_name: string): string => process.env.PET_TEST_USER_DATA ?? '',
  isPackaged: false,
  // pi-agent-core 的默认请求标识会读这两个
  getVersion: (): string => '0.0.0-test',
  getName: (): string => 'ai-desktop-pet-test'
}

export const shell = {
  trashItem: async (_path: string): Promise<void> => undefined
}

export class BrowserWindow {}
