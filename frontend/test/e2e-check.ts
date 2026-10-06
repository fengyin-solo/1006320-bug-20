import assert from 'node:assert'

// ---- 内存版 localStorage ----
const storage = new Map<string, string>()
const localStorageMock = {
  getItem: (k: string) => (storage.has(k) ? storage.get(k)! : null),
  setItem: (k: string, v: string) => storage.set(k, v),
  removeItem: (k: string) => storage.delete(k),
}
;(globalThis as any).window = { localStorage: localStorageMock }
;(globalThis as any).localStorage = localStorageMock

const { defaultStoreSeed } = await import('./test-seed.ts')
await defaultStoreSeed()

const { loadOverview } = await import('../src/api/local-service.ts')
const { judgeEnvRecord, reportEnvReading, importEnvRows, confirmMissing, envStats } = await import(
  '../src/api/env-service.ts'
)
const { listRows } = await import('../src/data/local-store.ts')
const { ENV_KEY, ENV_STATUS } = await import('../src/data/env-rules.ts')

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed += 1
  console.log('  ✓', name)
}

// 初始播种：1号舱最新正常、2号舱最新超标、3号舱最新正常、4号舱待采集；另有 2 条缺项记录（2号舱早年误记正常、3号舱缺湿度）
const initial = envStats()
check('初始：超标点位只算2号舱 1 个（1号舱虽有超标历史但最新正常）', () => {
  assert.equal(initial.overPoints, 1)
  assert.equal(initial.normalPoints, 2)
  assert.equal(initial.waitingPoints, 1)
  assert.equal(initial.confirmPoints, 0) // 缺项的两条都不是所在点位的最新记录
})
check('缺项记录逐条回填为待人工确认（共2条，不计正常也不计超标）', () => {
  const confirms = listRows(ENV_KEY).filter((r) => r.status === ENV_STATUS.confirm)
  assert.equal(confirms.length, 2)
})

// 概览同口径
const overview = loadOverview()
const envCell = overview.modules.find((m) => m.name === '廊内环境监测')!
check('概览异常量=点位口径超标数=1（氧气等不在概览另算）', () => {
  assert.equal(envCell.abnormal, 1)
})

// 2号舱超标记录：人工硬点"确认正常"但读数仍超限 -> 拒绝，异常数不减
const rows = () => listRows(ENV_KEY)
const overRow = rows().find((r) => r.status === '指标超标')!
let res = judgeEnvRecord(Number(overRow.id), '指标正常')
check('读数仍超标时点确认正常被拒绝，超标标记不被改写', () => {
  assert.equal(res.ok, false)
  assert.equal(envStats().overPoints, 1)
})

// 读数改为正常（模拟复测更新）后确认正常：记录与超标标记一起改写，异常数按点位回落
overRow['环境温度'] = 25.2
overRow['空气湿度'] = 70
;(overRow as any)['氧气浓度'] = 20.9
overRow['有害气体浓度'] = 8
// 直接改的是缓存对象的浅引用外的副本，走一次缺项确认不合适；改为用重新上报同时间重复逻辑不合适。
// 这里用模拟"复测"：新一笔正常读数上报
res = reportEnvReading({
  point: '2号舱K0+320',
  temperature: '25.2',
  humidity: '70',
  oxygen: '20.9',
  harmful: '8',
  collectedAt: '2026-10-06 10:30',
  operator: '李静',
})
check('复测正常读数上报后按统一口径自动判为正常', () => {
  assert.equal(res.ok, true)
  assert.ok(res.message.includes('指标正常'))
})

// 新记录生成后仍是"已采集后自动判定"？我们 normalizeEnvRow 直接判定为正常
const statsAfter = envStats()
check('超标点位数按点位重算回落到 0，正常点位 3 个', () => {
  assert.equal(statsAfter.overPoints, 0)
  assert.equal(statsAfter.normalPoints, 3)
})
check('概览异常量同步回落到 0', () => {
  assert.equal(loadOverview().modules.find((m) => m.name === '廊内环境监测')!.abnormal, 0)
})

// 再点一次确认（对已经正常的新记录）：不重复扣减
let latest2 = rows()
  .filter((r) => String(r['监测点位']) === '2号舱K0+320')
  .sort((a, b) => String(b['采集时间']).localeCompare(String(a['采集时间'])))[0]
// 读数正常时人工标记超标应被统一口径拒绝
res = judgeEnvRecord(Number(latest2.id), '指标超标')
assert.equal(res.ok, false)
// 模拟「已采集待判定」状态：通过存储层事务改，避免绕过缓存
const { commit } = await import('../src/data/local-store.ts')
{
  const r = commit((draft) => {
    const target = draft.entries[ENV_KEY].find((row) => Number(row.id) === Number(latest2.id))!
    target.status = '已采集'
    target.pending = true
    target.abnormal = false
  })
  assert.equal(r.ok, true)
}
res = judgeEnvRecord(Number(latest2.id), '指标正常')
check('已采集记录确认正常成功：记录、超标标记一并改写并写交接清单', () => {
  assert.equal(res.ok, true)
})
latest2 = rows().find((r) => Number(r.id) === Number(latest2.id))!
check('确认后该记录状态=指标正常、超标标记=正常', () => {
  assert.equal(latest2.status, '指标正常')
  assert.equal(latest2.abnormal, false)
})
res = judgeEnvRecord(Number(latest2.id), '指标正常')
check('同一点位重复确认被拦截，异常数不再被减一回', () => {
  assert.equal(res.ok, false)
  assert.ok(res.message.includes('重复确认'))
  assert.equal(envStats().overPoints, 0)
})

// 氧气浓度同一套口径：19.0 低于下限 -> 超标
res = reportEnvReading({
  point: '5号舱氧气测试点',
  temperature: '25',
  humidity: '60',
  oxygen: '19.0',
  harmful: '5',
  collectedAt: '2026-10-06 11:00',
  operator: '测试员',
})
check('氧气19.0%低于19.5%下限判超标（与概览同口径）', () => {
  assert.equal(res.ok, true)
  assert.ok(res.message.includes('指标超标'))
  assert.equal(envStats().overPoints, 1)
  assert.equal(loadOverview().modules.find((m) => m.name === '廊内环境监测')!.abnormal, 1)
})

// 重复上报：同点位同时间，只认第一次，差异记备注
res = reportEnvReading({
  point: '5号舱氧气测试点',
  temperature: '99',
  humidity: '60',
  oxygen: '19.0',
  harmful: '5',
  collectedAt: '2026-10-06 11:00',
  operator: '测试员',
})
const dup = rows().find((r) => String(r['监测点位']) === '5号舱氧气测试点' && String(r['采集时间']) === '2026-10-06 11:00')!
check('重复上报不改首次读数/判定，差异只进备注，记录数不增加', () => {
  assert.equal(res.ok, true)
  assert.ok(String(dup['备注']).includes('环境温度'))
  assert.equal(dup['环境温度'], '25')
  const count = rows().filter((r) => String(r['监测点位']) === '5号舱氧气测试点').length
  assert.equal(count, 1)
})

// 缺项人工确认：补齐早年2号舱缺项记录
const legacy = rows().find((r) => Number(r.id) === 6)!
check('早年缺项记录回填为待人工确认', () => {
  assert.equal(legacy.status, '待人工确认')
})
res = confirmMissing({ id: 6, temperature: '', humidity: '', oxygen: '', harmful: '' })
check('缺项不补直接确认被拒，本笔不入库', () => assert.equal(res.ok, false))
res = confirmMissing({ id: 6, temperature: '26', humidity: '65', oxygen: '20.8', harmful: '7' })
check('补齐四项后按统一口径判定正常', () => {
  assert.equal(res.ok, true)
  assert.ok(res.message.includes('指标正常'))
})

// 往期搬入：坏行整体退回
const beforeCount = rows().length
res = importEnvRows('监测点位,采集时间\n坏点,不是日期')
check('往期搬入遇到格式错误整批放弃，台账条数不变', () => {
  assert.equal(res.ok, false)
  assert.equal(rows().length, beforeCount)
})

// 往期搬入：正常批次含缺项逐条列出
res = importEnvRows(
  [
    '监测点位,采集时间,环境温度,空气湿度,氧气浓度,有害气体浓度,监测人员',
    '6号舱K1+010,2026-08-01,27,70,20.9,8,李静',
    '6号舱K1+010,2026-08-02,,70,,8,李静',
  ].join('\n'),
)
check('往期搬入成功，缺项逐条列出且状态为待人工确认', () => {
  assert.equal(res.ok, true)
  assert.equal(res.imported, 2)
  assert.equal(res.missing!.length, 1)
  const missRow = rows().find((r) => Number(r.id) === res.missing![0].id)!
  assert.equal(missRow.status, '待人工确认')
})

// 往期重复搬运同日期 -> 跳过不新增
const countBefore = rows().length
res = importEnvRows('监测点位,采集时间,环境温度,空气湿度,氧气浓度,有害气体浓度,监测人员\n6号舱K1+010,2026-08-01,27,70,20.9,8,李静')
check('同点位同巡检日期重复搬入只跳过计数，台账保持一致', () => {
  assert.equal(res.ok, true)
  assert.equal(res.duplicated, 1)
  assert.equal(rows().length, countBefore)
})

// 落库失败整套退回：让 notes 写入抛错
const snapshotEntries = JSON.parse(storage.get('urban-utility-tunnel:entries')!)
const snapshotNotes = storage.get('urban-utility-tunnel:handover-notes') ?? null
check('交接清单：环境监测入口与值班入口读同一份（超标确认/重复上报/往期搬运都已留痕）', () => {
  const notes = JSON.parse(storage.get('urban-utility-tunnel:handover-notes') ?? '[]') as string[]
  assert.ok(notes.some((n) => n.includes('环境监测结论')), '应有超标确认结论')
  assert.ok(notes.some((n) => n.includes('重复上报')), '应有重复上报差异备注')
  assert.ok(notes.some((n) => n.includes('往期搬运完成')), '应有往期搬运记录')
})
const originalSet = localStorageMock.setItem.bind(localStorageMock)
;(localStorageMock as any).setItem = function (this: unknown, k: string, v: string) {
  if (k === 'urban-utility-tunnel:handover-notes') {
    throw new Error('quota exceeded')
  }
  return originalSet(k, v)
}
res = reportEnvReading({
  point: '回滚测试点',
  temperature: '25',
  humidity: '60',
  oxygen: '21',
  harmful: '3',
  collectedAt: '2026-10-06 12:00',
  operator: '回滚测试',
})
;(localStorageMock as any).setItem = originalSet
check('落库失败整套退回：存储内容与缓存都不留下半笔', () => {
  assert.equal(res.ok, false)
  assert.ok(res.message.includes('退回'))
  assert.deepEqual(JSON.parse(storage.get('urban-utility-tunnel:entries')!), snapshotEntries)
  assert.equal(storage.get('urban-utility-tunnel:handover-notes'), snapshotNotes)
  assert.equal(rows().some((r) => String(r['监测点位']) === '回滚测试点'), false)
})

console.log(`\n全部 ${passed} 项链路验证通过`)
