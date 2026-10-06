// 测试辅助：模拟老版本浏览器里的存量数据（无 meta 版本戳），触发一次性回填。
export async function defaultStoreSeed(): Promise<void> {
  const ls = (globalThis as any).window.localStorage as Storage
  ls.removeItem('urban-utility-tunnel:entries')
  ls.removeItem('urban-utility-tunnel:handover-notes')
  ls.removeItem('urban-utility-tunnel:meta')

  const { SEED_ROWS } = await import('../src/data/seed.ts')
  ls.setItem('urban-utility-tunnel:entries', JSON.stringify(SEED_ROWS))
  // 故意不写 meta：local-store 首次加载会判定为 version 0 并执行存量回填
}
