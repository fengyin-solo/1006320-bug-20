import type { EntryRow } from './types'
import { appendRemark, applyEvaluation, ENV_STATUS, evaluateReading } from '../domain/env'

/**
 * 存量数据回填（v1 → v2）。
 * 幂等：已打「数据版本=2」标记的记录不再处理。
 *
 * 环境监测早年把「未采集」写成「指标正常」的记录区分办法（处理说明同口径）：
 *   四项取值（温度/湿度/氧气/有害气体）只要有一项采集不到可解析数值，就不承认它是正常，
 *   一律退回「待采集」并在备注里注明回填原因；数值齐全的按采集时间升序逐条重判，
 *   状态与超标标记统一由当前阈值口径改写，避免残留超标标记。
 */
export function migrateRows(
  source: Record<string, EntryRow[]>,
  fromVersion: number,
): Record<string, EntryRow[]> {
  if (fromVersion >= 2) {
    return source
  }
  const next: Record<string, EntryRow[]> = {}
  for (const [key, rows] of Object.entries(source)) {
    next[key] = key === 'envmonitor' ? migrateEnv(rows) : key === 'patrol' ? migratePatrol(rows) : rows.map(stampVersion)
  }
  return next
}

function stampVersion(row: EntryRow): EntryRow {
  if (row.数据版本 === 2 || row.数据版本 === '2') {
    return row
  }
  return { ...row, 数据版本: 2 }
}

function migrateEnv(rows: EntryRow[]): EntryRow[] {
  // 存量监测记录按采集时间回填（同一点位以最新采集为准的顺序重算）。
  const ordered = [...rows].sort((a, b) =>
    String(a.采集时间 ?? '').localeCompare(String(b.采集时间 ?? '')),
  )
  return ordered.map((row) => {
    if (row.数据版本 === 2 || row.数据版本 === '2') {
      return row
    }
    const evalResult = evaluateReading(row)
    const legacyStatus = String(row.status ?? '')
    let next: EntryRow
    if (!evalResult.collected) {
      // 早年把「未采集」写成「指标正常」：没有有效取值就不允许挂正常/超标，退回待采集等人工重采。
      const collectedAt = String(row.采集时间 ?? '').trim()
      const timeNote = collectedAt ? `采集时间${collectedAt}，` : '无采集时间，'
      const note = `存量回填：${timeNote}${evalResult.missing.join('、')}，原状态「${legacyStatus}」不成立，退回待采集`
      next = {
        ...row,
        status: ENV_STATUS.pending,
        pending: true,
        abnormal: false,
        超标判定: '未采集',
        超标原因: '',
        备注: appendRemark(row, note),
      }
      if (!collectedAt) {
        next.备注 = appendRemark(next, '存量回填：采集时间待人工确认')
      }
    } else {
      const note =
        legacyStatus === ENV_STATUS.normal && evalResult.abnormal
          ? '存量回填：原记指标正常但按统一口径复核超标，已纠正'
          : legacyStatus === ENV_STATUS.over && !evalResult.abnormal
            ? '存量回填：原记指标超标但按统一口径复核正常，已纠正'
            : '存量回填：按统一阈值口径复核判定'
      next = applyEvaluation(row, evalResult, note)
    }
    // 采集时间缺失（能进入这一支说明取值齐全）：不臆造时间，仅标注待人工确认。
    if (String(next.采集时间 ?? '').trim() === '') {
      next.采集时间 = ''
      next.备注 = appendRemark(next, '存量回填：缺采集时间，待人工确认')
    }
    next.数据版本 = 2
    return next
  })
}

function migratePatrol(rows: EntryRow[]): EntryRow[] {
  return rows.map((row) => {
    if (row.数据版本 === 2 || row.数据版本 === '2') {
      return row
    }
    const next: EntryRow = { ...row, 数据版本: 2 }
    if (String(next.巡检日期 ?? '').trim() === '' || String(next.巡检日期).includes('样例')) {
      const fallback = String(next.完成时间 ?? '').trim() || String(next.计划日期 ?? '').trim()
      if (fallback && !fallback.includes('样例')) {
        next.巡检日期 = fallback
        next.备注 = appendRemark(next, `存量回填：缺巡检日期，按${next.完成时间 === fallback ? '完成时间' : '计划日期'}暂代，待人工确认`)
      } else {
        next.巡检日期 = ''
        next.备注 = appendRemark(next, '存量回填：缺巡检日期，待人工确认')
      }
    }
    // 巡检的异常位只认「已上报」，避免种子/老数据里残留的 abnormal 与状态对不上。
    next.abnormal = String(next.status) === '已上报'
    return next
  })
}
