// 领域链路自检：node 运行，localStorage 用内存 shim。
import { envMetrics, evaluateReading, ENV_STATUS } from '../frontend/src/domain/env'
import { migrateRows } from '../frontend/src/data/migrations'
import { SEED_ROWS } from '../frontend/src/data/seed'
import { reportIssue, parseImportText, planImport, commitImport, confirmPatrolRow, PATROL_STATUS } from '../frontend/src/domain/patrol'
import { upsertApprovalLine, approvalHandoverLines } from '../frontend/src/domain/handover'

let passed = 0
function check(name: string, cond: boolean, extra = '') {
  if (!cond) {
    console.error(`FAIL: ${name} ${extra}`)
    process.exitCode = 1
  } else {
    passed += 1
    console.log(`PASS: ${name}`)
  }
}

// 1. 阈值口径：氧气缺氧/富氧
check('氧气18.6判超标(缺氧)', evaluateReading({ 环境温度: '24', 空气湿度: '60', 氧气浓度: '18.6', 有害气体浓度: '1' }).abnormal)
check('氧气24判超标(富氧)', evaluateReading({ 环境温度: '24', 空气湿度: '60', 氧气浓度: '24', 有害气体浓度: '1' }).abnormal)
check('氧气20.9正常', !evaluateReading({ 环境温度: '24', 空气湿度: '60', 氧气浓度: '20.9', 有害气体浓度: '1' }).abnormal)
check('温度35.8判超标', evaluateReading({ 环境温度: '35.8', 空气湿度: '60', 氧气浓度: '20.9', 有害气体浓度: '1' }).reasons.some((r) => r.includes('环境温度')))
check('未采集不判超标', !evaluateReading({ 环境温度: '', 空气湿度: '', 氧气浓度: '', 有害气体浓度: '' }).collected)

// 2. 存量回填
const migrated = migrateRows(JSON.parse(JSON.stringify(SEED_ROWS)), 1)
const env = migrated.envmonitor
const legacyBad = env.find((r) => String(r.监测编号) === 'ENVM-0003')
check('早年未采集写成正常→退回待采集', legacyBad!.status === ENV_STATUS.pending && !legacyBad!.abnormal, String(legacyBad!.status))
check('回填备注含原因', String(legacyBad!.备注).includes('退回待采集'))
const overPoint = env.find((r) => String(r.监测编号) === 'ENVM-0004')
check('ENVM-0004保持超标', overPoint!.status === ENV_STATUS.over && overPoint!.abnormal)
// ENVM-0002 同点位(1号综合舱)最新记录超标；ENVM-0001 正常旧记录不应再把点位算成两个
const m = envMetrics(env)
check('超标点位按点位去重=2(1号综合舱,3号燃气舱)', m.abnormalPoints === 2, `got ${m.abnormalPoints}`)
check('待采集点位=2(2号电力舱,4号水信舱)', m.pendingPoints === 2, `got ${m.pendingPoints}`)
check('点位总数=4', m.totalPoints === 4, `got ${m.totalPoints}`)
check('迁移幂等', JSON.stringify(migrateRows(JSON.parse(JSON.stringify(migrated)), 2).envmonitor) === JSON.stringify(env))

// 3. 重复上报只认第一次
const task: any = { id: 1, status: PATROL_STATUS.running, pending: true, abnormal: false }
const first = reportIssue(task, { problems: '支架锈蚀', detail: 'A点' })
check('首报落内容', first.row.上报问题 === '支架锈蚀' && first.row.status === PATROL_STATUS.reported)
const second = reportIssue(first.row, { problems: '照明损坏', detail: 'B点' })
check('重复上报不改首报', second.row.上报问题 === '支架锈蚀' && second.row.上报明细 === 'A点')
check('差异进备注', String(second.row.备注).includes('照明损坏') && String(second.row.备注).includes('以首次上报为准'))
check('上报次数累加', Number(second.row.上报次数) === 2)

// 4. 往期搬入：缺项列出 + 按日期排序 + 台账不被覆盖 + 失败回滚(存储层在浏览器侧验证)
const csv = [
  'PATR-1001,北线,甲班,2025-01-03,2025-01-03,2025-01-03,1,张三,已完成',
  'PATR-1002,南线,,2025-01-01,,,,,巡检中',
  'PATR-1003,中线,乙班,2025-01-02,2025-01-02,2025-01-02,0,李四,',
  'PATR-1004,重复编号行,,,,,,,,',
  'PATR-1004,重复编号行,,,,,,,,',
].join('\n')
const parsed = parseImportText(csv)
const preview = planImport([], parsed.values)
check('文件内重复编号阻断', preview.errors.length === 1, preview.errors.join(';'))
check('预案3条', preview.drafts.length === 3)
const missingRow = preview.drafts.find((d) => String(d.row.巡检编号) === 'PATR-1002')
check('缺项待确认且列字段', missingRow!.row.status === PATROL_STATUS.waitingConfirm && String(missingRow!.row.缺失字段).includes('巡检班组'), String(missingRow!.row.缺失字段))
const { rows, result } = commitImport([], preview)
check('按巡检日期排序入库', rows.map((r) => String(r.巡检编号)).join() === 'PATR-1002,PATR-1003,PATR-1001')
check('待确认计数=1', result.pendingConfirm === 1)
// 台账对齐：台账原值不被覆盖，差异记备注
const existing: any[] = [{ id: 9, status: '已完成', pending: false, abnormal: false, 巡检编号: 'PATR-2001', 巡检路线: '台账路线', 巡检班组: '甲班', 巡检日期: '2025-02-01' }]
const p2 = planImport(existing, parseImportText('PATR-2001,导入路线,甲班,2025-02-01,2025-02-01,2025-02-01,0,张三,已完成').values)
check('对齐识别差异', p2.drafts[0].op === '台账对齐' && p2.drafts[0].differences.length >= 1)
const c2 = commitImport(existing, p2)
check('台账值保持不变', c2.rows[0].巡检路线 === '台账路线' && String(c2.rows[0].备注).includes('导入「导入路线」'))
// 人工补录
const filled = confirmPatrolRow(missingRow!.row, { 巡检班组: '乙班', 巡检人员: '王五', 计划日期: '2025-01-01', 完成时间: '2025-01-01 10:00', 发现问题数: '0' })
check('补录后回待巡检', filled.status === PATROL_STATUS.pending && !String(filled.缺失字段 ?? ''))

// 5. 审批结论两处一致 + 同申请 upsert
let duty: any[] = []
duty = upsertApprovalLine(duty, { applyId: 'ENTR-1', result: '批准', time: '2026-10-06 09:00', text: 'A' })
duty = upsertApprovalLine(duty, { applyId: 'ENTR-2', result: '驳回', time: '2026-10-06 09:05', text: 'B' })
duty = upsertApprovalLine(duty, { applyId: 'ENTR-1', result: '完工', time: '2026-10-06 10:00', text: 'A2' })
const lines = approvalHandoverLines(duty)
check('同申请只保留一条(共2条)', lines.length === 2)
check('ENTR-1更新为完工', lines.find((l) => l.applyId === 'ENTR-1')!.result === '完工')
check('两处同源：自动交接记录仅1条且含两结论', duty.length === 1 && String(duty[0].交接事项).split('\n').length === 2)

console.log(`\n${passed} checks passed`)
