import type { EntryRow } from './types'

/**
 * 廊内环境监测领域规则：全平台唯一的判定口径。
 *
 * 概览、列表、详情、上报、批量搬运都只能用这里的 evaluateEnvReading，
 * 谁也不准在别处另算一遍（尤其氧气浓度）。
 * 判定阈值依据 GBZ 2.1 与 GB 8958 等有限空间作业的常用控制限：
 *   环境温度 5℃～32℃；空气湿度不高于 85%；
 *   氧气浓度 19.5%～23.5%；有害气体（以可燃气/CO 综合当量计）不高于 25（mg/m³ 或 %LEL 口径）。
 */

export const ENV_KEY = 'envmonitor'
export const ENV_STATUS = {
  waiting: '待采集',
  collected: '已采集',
  normal: '指标正常',
  over: '指标超标',
  confirm: '待人工确认',
} as const

export const ENV_METRIC_FIELDS = ['环境温度', '空气湿度', '氧气浓度', '有害气体浓度'] as const
export type EnvMetricField = (typeof ENV_METRIC_FIELDS)[number]

export type EnvLimit = { min: number; max: number; unit: string; desc: string }

export const ENV_LIMITS: Record<EnvMetricField, EnvLimit> = {
  环境温度: { min: 5, max: 32, unit: '℃', desc: '区间 [5, 32]' },
  空气湿度: { min: 0, max: 85, unit: '%RH', desc: '上限 85' },
  氧气浓度: { min: 19.5, max: 23.5, unit: '%VOL', desc: '区间 [19.5, 23.5]' },
  有害气体浓度: { min: 0, max: 25, unit: 'mg/m³', desc: '上限 25' },
}

/** 判定结果：null 表示读数缺失/不可解析（缺项），不得当作正常。 */
export type EnvVerdict = {
  status: (typeof ENV_STATUS)['normal'] | (typeof ENV_STATUS)['over']
  abnormal: boolean
  reasons: string[]
} | null

/** 读数解析：空串、占位文本、NaN 都按未采集处理。 */
export function parseReading(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  if (typeof value !== 'string') {
    return null
  }
  const text = value.trim().replace(/[%℃RHLELmg/m³\s]/gi, '')
  if (text === '') {
    return null
  }
  const num = Number(text)
  return Number.isFinite(num) ? num : null
}

/** 四项指标是否全部有有效读数。 */
export function hasFullReading(row: Pick<EntryRow, EnvMetricField | string>): boolean {
  return ENV_METRIC_FIELDS.every((field) => parseReading(row[field]) !== null)
}

/** 缺失的指标项，逐条返回字段名。 */
export function missingMetrics(row: Pick<EntryRow, EnvMetricField | string>): EnvMetricField[] {
  return ENV_METRIC_FIELDS.filter((field) => parseReading(row[field]) === null)
}

/** 唯一判定口径：四项齐全且全部在限才算正常；任一缺项返回 null（交人工确认）。 */
export function evaluateEnvReading(row: Pick<EntryRow, EnvMetricField | string>): EnvVerdict {
  const reasons: string[] = []
  for (const field of ENV_METRIC_FIELDS) {
    const num = parseReading(row[field])
    if (num === null) {
      return null
    }
    const limit = ENV_LIMITS[field]
    if (num < limit.min || num > limit.max) {
      reasons.push(`${field}=${num}${limit.unit}，应满足${limit.desc}`)
    }
  }
  if (reasons.length > 0) {
    return { status: ENV_STATUS.over, abnormal: true, reasons }
  }
  return { status: ENV_STATUS.normal, abnormal: false, reasons: [] }
}

/** 阈值说明文本：交接清单和处理说明里都引用这份，避免两处口径漂移。 */
export function envLimitText(): string {
  return ENV_METRIC_FIELDS.map((field) => {
    const limit = ENV_LIMITS[field]
    return `${field}${limit.desc}${limit.unit}`
  }).join('；')
}

/**
 * 把环境监测行规范成统一形态：
 * status / pending / abnormal 全部由「读数 + 判定口径」重算，历史脏标志一并覆盖。
 * 缺项一律转「待人工确认」，早年把未采集写成正常的记录由此被识别出来。
 * 读数为空（一项都没采）才保留「待采集」；有读数就必须按口径判出正常/超标/缺项。
 */
export function normalizeEnvRow(row: EntryRow): EntryRow {
  const anyReading = ENV_METRIC_FIELDS.some((field) => parseReading(row[field]) !== null)
  if (row.status === ENV_STATUS.waiting && !anyReading) {
    return { ...row, pending: true, abnormal: false, 缺项确认: false }
  }
  const verdict = evaluateEnvReading(row)
  if (verdict === null) {
    const missing = missingMetrics(row)
    const note = `缺项待确认：${missing.join('、')}`
    const remarks = String(row['备注'] ?? '')
    return {
      ...row,
      status: ENV_STATUS.confirm,
      pending: true,
      abnormal: false,
      缺项确认: false,
      备注: remarks.includes(note) ? remarks : remarks ? `${remarks}；${note}` : note,
    }
  }
  return {
    ...row,
    status: verdict.status,
    pending: false,
    abnormal: verdict.abnormal,
    缺项确认: false,
  }
}

/** 点位的判定状态：待采集 < 待人工确认 < 指标正常 < 指标超标，取同一点位最新记录中最靠后的状态。 */
const POINT_STATE_RANK = [
  ENV_STATUS.waiting,
  ENV_STATUS.confirm,
  ENV_STATUS.normal,
  ENV_STATUS.over,
] as const
export type PointState = (typeof POINT_STATE_RANK)[number]

export type EnvPointStat = {
  point: string
  state: PointState
  latestCollectedAt: string
  latestId: number
}

/** 采集时间排序：支持 YYYY-MM-DD 与 YYYY-MM-DD HH:mm；解析不了退到 id。 */
function collectedTimeValue(row: EntryRow): number {
  const text = String(row['采集时间'] ?? '').trim()
  const normalized = text.replace(/-/g, '/')
  const time = new Date(normalized).getTime()
  return Number.isFinite(time) ? time : 0
}

/**
 * 按监测点位重算（绝不做标志位累加）：
 * 每个点位只认采集时间最新的一条记录，同时间再以 id 大者为准。
 */
export function envPointStats(rows: EntryRow[]): EnvPointStat[] {
  const latestByPoint = new Map<string, EntryRow>()
  for (const row of rows) {
    const point = String(row['监测点位'] ?? '').trim()
    if (!point) {
      continue
    }
    const current = latestByPoint.get(point)
    if (!current) {
      latestByPoint.set(point, row)
      continue
    }
    const currentTime = collectedTimeValue(current)
    const rowTime = collectedTimeValue(row)
    if (rowTime > currentTime || (rowTime === currentTime && Number(row.id) > Number(current.id))) {
      latestByPoint.set(point, row)
    }
  }
  return [...latestByPoint.entries()].map(([point, row]) => {
    const status = String(row.status) as PointState
    return {
      point,
      state: POINT_STATE_RANK.includes(status) ? status : ENV_STATUS.waiting,
      latestCollectedAt: String(row['采集时间'] ?? ''),
      latestId: Number(row.id),
    }
  })
}

export type EnvOverview = {
  pointsTotal: number
  waitingPoints: number
  normalPoints: number
  overPoints: number
  confirmPoints: number
  recordsTotal: number
}

/** 概览/列表/看板共用的汇总：超标点位数 = 最新状态为「指标超标」的去重点位数。 */
export function envOverview(rows: EntryRow[]): EnvOverview {
  const points = envPointStats(rows)
  return {
    pointsTotal: points.length,
    waitingPoints: points.filter((item) => item.state === ENV_STATUS.waiting).length,
    normalPoints: points.filter((item) => item.state === ENV_STATUS.normal).length,
    overPoints: points.filter((item) => item.state === ENV_STATUS.over).length,
    confirmPoints: points.filter((item) => item.state === ENV_STATUS.confirm).length,
    recordsTotal: rows.length,
  }
}

/**
 * 存量监测记录回填：按采集时间排序后逐条规范化。
 * 是否执行回填由存储层版本号决定，这里逐条重算并统一盖「存量回填」戳；幂等。
 */
export function backfillEnvRows(rows: EntryRow[]): EntryRow[] {
  const sorted = [...rows].sort((a, b) => {
    const diff = collectedTimeValue(a) - collectedTimeValue(b)
    return diff !== 0 ? diff : Number(a.id) - Number(b.id)
  })
  return sorted.map((row) => {
    const normalized = normalizeEnvRow(row)
    // 人工新数据不会进回填通道；存量行即使已带戳也统一按本次口径重算一遍
    return { ...normalized, 数据来源: '存量回填' }
  })
}
