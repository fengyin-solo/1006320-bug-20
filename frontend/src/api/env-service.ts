import { commit, listRows } from '@/data/local-store'
import {
  ENV_KEY,
  ENV_METRIC_FIELDS,
  ENV_STATUS,
  envOverview,
  evaluateEnvReading,
  missingMetrics,
  normalizeEnvRow,
  parseReading,
} from '@/data/env-rules'
import { addHandoverNote } from '@/data/handover'
import type { ActionResult, EntryRow } from '@/data/types'

export type EnvReadingInput = {
  point: string
  temperature: string
  humidity: string
  oxygen: string
  harmful: string
  collectedAt: string
  operator: string
}

export type EnvReportResult = ActionResult & {
  duplicated?: boolean
}

function nowStamp(): string {
  const date = new Date()
  const pad = (num: number) => String(num).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function toRowValues(input: EnvReadingInput): Pick<EntryRow, (typeof ENV_METRIC_FIELDS)[number]> {
  return {
    环境温度: input.temperature.trim(),
    空气湿度: input.humidity.trim(),
    氧气浓度: input.oxygen.trim(),
    有害气体浓度: input.harmful.trim(),
  }
}

function diffRemarks(existing: EntryRow, values: ReturnType<typeof toRowValues>): string[] {
  const remarks: string[] = []
  for (const field of ENV_METRIC_FIELDS) {
    const before = String(existing[field] ?? '').trim()
    const after = String(values[field] ?? '').trim()
    if (after !== '' && before !== after) {
      remarks.push(`${field}: ${before || '空'}→${after}（后续上报，仅备注）`)
    }
  }
  return remarks
}

/**
 * 重复上报口径：同一点位 + 同一采集时间只认第一次的内容。
 * 后续上报不改判定、不改读数，差异逐条追加到首报记录的备注，并在交接清单留痕。
 */
export function reportEnvReading(input: EnvReadingInput): EnvReportResult {
  if (!input.point.trim()) {
    return { ok: false, message: '监测点位必填' }
  }
  if (!input.collectedAt.trim()) {
    return { ok: false, message: '采集时间必填' }
  }

  const result = commit((draft) => {
    const rows = draft.entries[ENV_KEY] ?? []
    const values = toRowValues(input)
    const existing = rows.find(
      (row) =>
        String(row['监测点位']).trim() === input.point.trim() &&
        String(row['采集时间']).trim() === input.collectedAt.trim(),
    )

    if (existing) {
      const diffs = diffRemarks(existing, values)
      if (diffs.length === 0) {
        return { duplicated: true, changed: false, note: '' }
      }
      const merged = [...String(existing['备注'] ?? '').split('；').filter(Boolean), ...diffs].join('；')
      existing['备注'] = merged
      return {
        duplicated: true,
        changed: true,
        note: `重复上报：${input.point} ${input.collectedAt} 只保留首次内容，差异 ${diffs.length} 项已记入备注`,
      }
    }

    const base: EntryRow = {
      id: nextId(rows),
      status: ENV_STATUS.waiting,
      pending: true,
      abnormal: false,
      监测编号: `ENVM-${String(nextId(rows)).padStart(4, '0')}`,
      监测点位: input.point.trim(),
      ...values,
      采集时间: input.collectedAt.trim(),
      监测人员: input.operator.trim() || '未填',
      监测状态: '',
      备注: '',
      缺项确认: false,
      数据来源: '人工上报',
    }
    const normalized = normalizeEnvRow(base)
    normalized['监测状态'] = normalized.status
    rows.push(normalized)
    return { duplicated: false, changed: true, note: '', status: normalized.status, id: normalized.id }
  })

  if (!result.ok) {
    return { ok: false, message: `落库失败，已整套退回：${result.error.message}` }
  }
  const value = result.value
  if (value.note) {
    addHandoverNote(`[${nowStamp()}] ${value.note}`)
  }
  if (value.duplicated) {
    return {
      ok: true,
      duplicated: true,
      message: value.changed ? '该点位该时间已有首次上报，差异已记入备注，判定以首次为准' : '该点位该时间已上报过，内容一致，未重复计数',
    }
  }
  return { ok: true, message: `已接收首次上报，当前判定「${value.status}」` }
}

/**
 * 确认判定：指标正常 / 标记超标都必须过同一套判定口径，
 * 人工点的状态如果和读数判出来的不一致，拒绝改写，避免硬写一个错标志。
 */
export function judgeEnvRecord(id: number, target: '指标正常' | '指标超标'): ActionResult {
  type JudgeOutcome =
    | { found: false }
    | { found: true; needConfirm: true }
    | { found: true; needConfirm: false; mismatch: true; actual: string; reasons: string[] }
    | { found: true; needConfirm: false; mismatch: false; unchanged: boolean; status: string; point: string }

  const result = commit<JudgeOutcome>((draft) => {
    const rows = draft.entries[ENV_KEY] ?? []
    const row = rows.find((item) => Number(item.id) === id)
    if (!row) {
      return { found: false }
    }
    if (String(row.status) === ENV_STATUS.confirm) {
      return { found: true, needConfirm: true }
    }
    const verdict = evaluateEnvReading(row)
    if (verdict === null) {
      return { found: true, needConfirm: true }
    }
    if (verdict.status !== target) {
      return {
        found: true,
        needConfirm: false,
        mismatch: true,
        actual: verdict.status,
        reasons: verdict.reasons,
      }
    }
    if (String(row.status) === target) {
      return { found: true, needConfirm: false, mismatch: false, unchanged: true, status: target, point: String(row['监测点位']) }
    }
    row.status = verdict.status
    row.pending = false
    row.abnormal = verdict.abnormal
    row['监测状态'] = verdict.status
    row['缺项确认'] = false
    return { found: true, needConfirm: false, mismatch: false, unchanged: false, status: verdict.status, point: String(row['监测点位']) }
  })

  if (!result.ok) {
    return { ok: false, message: `落库失败，已整套退回：${result.error.message}` }
  }
  const value = result.value
  if (!value.found) {
    return { ok: false, message: `没有找到编号为 ${id} 的环境监测记录` }
  }
  if (value.needConfirm) {
    return { ok: false, message: '该记录存在缺项，请先在「缺项确认」里补齐读数后再判定' }
  }
  if (value.mismatch) {
    return {
      ok: false,
      message: `读数判定结果为「${value.actual}」，不能人工改写成「${target}」${value.reasons.length ? `；${value.reasons.join('；')}` : ''}`,
    }
  }
  if (value.unchanged) {
    return { ok: false, message: `该记录已是「${target}」，重复确认不再改变异常数` }
  }
  // 结论写进其它入口（值班交接）共用的交接清单，两处读到同一条
  addHandoverNote(
    `[${nowStamp()}] 环境监测结论：${value.point}（记录#${id}）确认为「${value.status}」，监测记录与超标标记一并改写，超标点位数按点位重算`,
  )
  return { ok: true, message: `监测记录与超标标记已一并改写为「${value.status}」，超标点位数按点位重算` }
}

export type ConfirmMissingInput = {
  id: number
  temperature: string
  humidity: string
  oxygen: string
  harmful: string
}

/** 缺项人工确认：逐条补齐读数后仍走统一判定，确认前的记录不参与正常/超标统计。 */
export function confirmMissing(input: ConfirmMissingInput): ActionResult {
  const result = commit((draft) => {
    const rows = draft.entries[ENV_KEY] ?? []
    const row = rows.find((item) => Number(item.id) === input.id)
    if (!row) {
      return { found: false as const }
    }
    const patch: Record<string, string> = {
      环境温度: input.temperature.trim(),
      空气湿度: input.humidity.trim(),
      氧气浓度: input.oxygen.trim(),
      有害气体浓度: input.harmful.trim(),
    }
    const stillMissing = ENV_METRIC_FIELDS.filter((field) => parseReading(patch[field]) === null)
    if (stillMissing.length > 0) {
      return { found: true as const, missing: stillMissing }
    }
    Object.assign(row, patch)
    const normalized = normalizeEnvRow(row)
    Object.assign(row, {
      status: normalized.status,
      pending: normalized.pending,
      abnormal: normalized.abnormal,
      缺项确认: true,
      数据来源: '缺项补录',
    })
    row['监测状态'] = row.status
    return { found: true as const, missing: [] as string[], status: row.status, point: String(row['监测点位']) }
  })

  if (!result.ok) {
    return { ok: false, message: `落库失败，已整套退回：${result.error.message}` }
  }
  const value = result.value
  if (!value.found) {
    return { ok: false, message: `没有找到编号为 ${input.id} 的环境监测记录` }
  }
  if (value.missing.length > 0) {
    return { ok: false, message: `仍有 ${value.missing.join('、')} 未填有效数值，本笔未入库` }
  }
  return { ok: true, message: `缺项已补齐并按统一口径判定为「${value.status}」` }
}

export type EnvImportResult = ActionResult & {
  imported?: number
  duplicated?: number
  missing?: { id: number; point: string; collectedAt: string; fields: string[] }[]
}

/**
 * 往期数据整体搬入：按巡检日期（解析为采集时间）整批导入。
 * 先在草稿上解析全部行，任一行有致命错误就整体放弃；落库仍走事务，失败整套退回。
 * 缺项不猜值、不沿用历史读数：标「待人工确认」逐条列出来，导入后与台账现状保持一致。
 */
export function importEnvRows(rawText: string): EnvImportResult {
  const lines = rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')

  if (lines.length <= 1) {
    return { ok: false, message: '没有可导入的明细（首行须为表头）' }
  }

  const header = splitCsvLine(lines[0]).map((cell) => cell.trim())
  const required = ['监测点位', '采集时间']
  const headerIndex = new Map(header.map((name, index) => [name, index]))
  for (const name of required) {
    if (!headerIndex.has(name)) {
      return { ok: false, message: `表头缺少必需列「${name}」，未写入任何数据` }
    }
  }

  type Parsed = {
    point: string
    collectedAt: string
    operator: string
    values: Record<string, string>
    lineNo: number
  }
  const parsed: Parsed[] = []
  for (let i = 1; i < lines.length; i += 1) {
    const cells = splitCsvLine(lines[i])
    const get = (name: string) => String(cells[headerIndex.get(name) ?? -1] ?? '').trim()
    const point = get('监测点位')
    const collectedAt = get('采集时间')
    if (!point || !collectedAt) {
      return { ok: false, message: `第 ${i + 1} 行监测点位或采集时间为空，整批未导入` }
    }
    if (!/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/.test(collectedAt)) {
      return { ok: false, message: `第 ${i + 1} 行采集时间格式应为 YYYY-MM-DD 或 YYYY-MM-DD HH:mm，整批未导入` }
    }
    parsed.push({
      point,
      collectedAt,
      operator: get('监测人员') || '往期搬运',
      values: {
        环境温度: get('环境温度'),
        空气湿度: get('空气湿度'),
        氧气浓度: get('氧气浓度'),
        有害气体浓度: get('有害气体浓度'),
      },
      lineNo: i + 1,
    })
  }

  const result = commit((draft) => {
    const rows = draft.entries[ENV_KEY] ?? []
    let seq = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0)
    const keyOf = (point: string, time: string) => `${point}@@${time}`
    const batchKeys = new Set<string>()
    let imported = 0
    let duplicated = 0
    const missing: NonNullable<EnvImportResult['missing']> = []

    for (const item of parsed) {
      const normalizedTime = item.collectedAt.length === 10 ? `${item.collectedAt} 00:00` : item.collectedAt
      const key = keyOf(item.point, normalizedTime)
      const existing = rows.find(
        (row) => keyOf(String(row['监测点位']).trim(), String(row['采集时间']).trim()) === key,
      )
      if (existing || batchKeys.has(key)) {
        duplicated += 1
        if (existing) {
          const tail = `往期搬运：${normalizedTime} 同点位同时间已有台账记录，仅保留台账原值`
          const remarks = String(existing['备注'] ?? '')
          if (!remarks.includes(tail)) {
            existing['备注'] = remarks ? `${remarks}；${tail}` : tail
          }
        }
        continue
      }
      batchKeys.add(key)
      seq += 1
      const base: EntryRow = {
        id: seq,
        status: ENV_STATUS.waiting,
        pending: true,
        abnormal: false,
        监测编号: `ENVM-${String(seq).padStart(4, '0')}`,
        监测点位: item.point,
        ...item.values,
        采集时间: normalizedTime,
        监测人员: item.operator,
        监测状态: '',
        备注: '往期数据按巡检日期整体搬入',
        缺项确认: false,
        数据来源: '往期搬运',
      }
      const normalized = normalizeEnvRow(base)
      normalized['监测状态'] = normalized.status
      rows.push(normalized)
      imported += 1
      const miss = missingMetrics(normalized)
      if (miss.length > 0) {
        missing.push({
          id: seq,
          point: item.point,
          collectedAt: normalized['采集时间'] as string,
          fields: miss,
        })
      }
    }
    return { imported, duplicated, missing }
  })

  if (!result.ok) {
    return { ok: false, message: `落库失败，已整套退回，台账未改动：${result.error.message}` }
  }
  const { imported, duplicated, missing } = result.value
  const summary = `往期搬运完成：新增 ${imported} 条，重复跳过 ${duplicated} 条，缺项待确认 ${missing.length} 条（缺项不猜值，逐条人工补录）`
  addHandoverNote(`[${nowStamp()}] ${summary}`)
  return { ok: true, message: summary, imported, duplicated, missing }
}

/** 列表/概览/看板共用的汇总入口，确保超标点位数各处一致（氧气等四项同口径）。 */
export function envStats() {
  return envOverview(listRows(ENV_KEY))
}

/** 简易 CSV 行切分：支持双引号包裹与引号转义。 */
function splitCsvLine(line: string): string[] {
  const cells: string[] = []
  let current = ''
  let quoted = false
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]
    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"'
          i += 1
        } else {
          quoted = false
        }
      } else {
        current += char
      }
    } else if (char === '"') {
      quoted = true
    } else if (char === ',') {
      cells.push(current)
      current = ''
    } else {
      current += char
    }
  }
  cells.push(current)
  return cells
}
