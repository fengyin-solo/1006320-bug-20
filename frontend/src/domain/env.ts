import type { EntryRow, EnvEvaluation, EnvMetrics } from '@/data/types'

/**
 * 廊内环境监测领域规则。
 * 全平台只有这一套判定口径：页面列表、详情面板、概览看板、另存清单、动作流转、
 * 存量回填都调用 evaluateReading，氧气浓度也走同一函数，概览不许另算一遍。
 */

export const ENV_FIELDS = {
  temperature: '环境温度',
  humidity: '空气湿度',
  oxygen: '氧气浓度',
  harmfulGas: '有害气体浓度',
} as const

type Rule = {
  field: string
  label: string
  unit: string
  // 闭区间之外（含等号边界）算超标；min/max 为阈值。
  min: number
  max: number
  lowHint: string
  highHint: string
}

// 管廊环境常用控制阈值：温度 5~32℃、湿度 ≤85%RH、氧含量 19.5%~23.5%、有害气体（H2S 当量）≤10ppm。
const RULES: Rule[] = [
  { field: ENV_FIELDS.temperature, label: '环境温度', unit: '℃', min: 5, max: 32, lowHint: '低于', highHint: '高于' },
  { field: ENV_FIELDS.humidity, label: '空气湿度', unit: '%RH', min: 0, max: 85, lowHint: '低于', highHint: '高于' },
  { field: ENV_FIELDS.oxygen, label: '氧气浓度', unit: '%VOL', min: 19.5, max: 23.5, lowHint: '低于下限（缺氧）', highHint: '高于上限（富氧）' },
  { field: ENV_FIELDS.harmfulGas, label: '有害气体浓度', unit: 'ppm', min: 0, max: 10, lowHint: '低于', highHint: '高于' },
]

export function parseReading(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  const text = String(value).trim()
  if (text === '' || text.includes('样例')) {
    return null
  }
  const matched = text.match(/-?\d+(\.\d+)?/)
  if (!matched) {
    return null
  }
  const num = Number(matched[0])
  return Number.isFinite(num) ? num : null
}

export function evaluateReading(row: Record<string, unknown>): EnvEvaluation {
  const items = RULES.map((rule) => {
    const value = parseReading(row[rule.field])
    if (value === null) {
      return {
        field: rule.field,
        label: rule.label,
        value: null,
        unit: rule.unit,
        abnormal: false,
        reason: `${rule.label}未采集`,
      }
    }
    const abnormal = value < rule.min || value > rule.max
    let reason = ''
    if (value < rule.min) {
      reason = `${rule.label}${rule.lowHint}下限 ${rule.min}${rule.unit}（实测${value}${rule.unit}）`
    } else if (value > rule.max) {
      reason = `${rule.label}${rule.highHint}上限 ${rule.max}${rule.unit}（实测${value}${rule.unit}）`
    }
    return {
      field: rule.field,
      label: rule.label,
      value,
      unit: rule.unit,
      abnormal,
      reason,
    }
  })

  const reasons = items.filter((item) => item.abnormal).map((item) => item.reason)
  const missing = items.filter((item) => item.value === null).map((item) => item.reason)
  const collected = missing.length === 0
  return { collected, abnormal: reasons.length > 0, items, reasons, missing }
}

export const ENV_STATUS = {
  pending: '待采集',
  collected: '已采集',
  normal: '指标正常',
  over: '指标超标',
} as const

export function isEnvOver(row: EntryRow): boolean {
  const evalResult = evaluateReading(row)
  if (!evalResult.collected) {
    return false
  }
  return evalResult.abnormal
}

function latestByPoint(rows: EntryRow[]): Map<string, EntryRow> {
  // 同一监测点位有多条采集记录时，以采集时间最新的一条为该点位现状。
  const latest = new Map<string, EntryRow>()
  const sorted = [...rows].sort((a, b) => String(a.采集时间 ?? '').localeCompare(String(b.采集时间 ?? '')))
  for (const row of sorted) {
    latest.set(String(row.监测点位 ?? ''), row)
  }
  return latest
}

/** 超标点位数按监测点位重算：同一点位只计一次，绝不累加。 */
export function envMetrics(rows: EntryRow[]): EnvMetrics {
  const latest = [...latestByPoint(rows).values()]
  const pendingPoints = latest.filter((row) => String(row.status) === ENV_STATUS.pending || !evaluateReading(row).collected).length
  const abnormalPoints = latest.filter((row) => String(row.status) === ENV_STATUS.over || isEnvOver(row)).length
  const normalPoints = latest.filter((row) => String(row.status) === ENV_STATUS.normal && !isEnvOver(row) && evaluateReading(row).collected).length
  return {
    totalPoints: latest.length,
    pendingPoints,
    normalPoints,
    abnormalPoints,
  }
}

export function appendRemark(row: EntryRow, note: string): string {
  const existed = String(row.备注 ?? '').trim()
  if (!existed) {
    return note
  }
  return existed.includes(note) ? existed : `${existed}；${note}`
}

/** 由判定结论回写监测记录：确认正常/标记超标时监测记录与超标标记一起改写成同一结论。 */
export function applyEvaluation(row: EntryRow, evalResult: EnvEvaluation, note?: string): EntryRow {
  const status = !evalResult.collected
    ? ENV_STATUS.pending
    : evalResult.abnormal
      ? ENV_STATUS.over
      : ENV_STATUS.normal
  const next: EntryRow = {
    ...row,
    status,
    pending: status !== ENV_STATUS.normal && status !== ENV_STATUS.over,
    abnormal: evalResult.collected && evalResult.abnormal,
    超标原因: evalResult.reasons.join('；'),
    超标判定: evalResult.collected ? (evalResult.abnormal ? '超标' : '正常') : '未采集',
  }
  if (note) {
    next.备注 = appendRemark(next, note)
  }
  return next
}

export function formatReading(row: EntryRow, field: string): string {
  const rule = RULES.find((item) => item.field === field)
  const value = parseReading(row[field])
  return value === null ? '未采集' : `${value}${rule?.unit ?? ''}`
}
