import type { EntryRow, PatrolCommitResult, PatrolDraft, PatrolImportPreview } from '@/data/types'

/**
 * 廊内巡检领域规则。
 * - 重复上报：同一条巡检任务再次上报问题，只认第一次的内容，后续差异追加到备注，不覆盖首报。
 * - 往期搬入：按巡检日期整体导入；缺失字段不臆造、不内插，逐条列出待人工确认。
 * - 整套落库：预案（draft）阶段不碰台账，commit 走整库事务，失败整套退回。
 */

export const PATROL_STATUS = {
  pending: '待巡检',
  running: '巡检中',
  done: '已完成',
  reported: '已上报',
  waitingConfirm: '待确认',
} as const

export const PATROL_FIELDS = ['巡检编号', '巡检路线', '巡检班组', '巡检日期', '计划日期', '完成时间', '发现问题数', '巡检人员', '巡检状态'] as const
const REQUIRED_FIELDS = ['巡检编号', '巡检路线', '巡检班组', '巡检日期']
// 缺失时不自动补值、只列出来等人工确认的字段（含取值字段）。
const VALUE_FIELDS = ['巡检路线', '巡检班组', '巡检日期', '计划日期', '完成时间', '巡检人员']

function hasValue(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false
  }
  const text = String(value).trim()
  return text !== '' && !text.includes('样例')
}

export function appendPatrolRemark(row: EntryRow, note: string): string {
  const existed = String(row.备注 ?? '').trim()
  if (!existed) {
    return note
  }
  return existed.includes(note) ? existed : `${existed}；${note}`
}

/** 重复上报只认第一次内容：字段差异逐条进备注，首报字段保持不动。 */
export function reportIssue(current: EntryRow, payload: { problems: string; detail: string }): { row: EntryRow; message: string } {
  const firstProblems = String(current.上报问题 ?? '').trim()
  if (!firstProblems) {
    return {
      row: {
        ...current,
        status: PATROL_STATUS.reported,
        pending: false,
        abnormal: true,
        上报问题: payload.problems,
        上报明细: payload.detail,
        上报次数: 1,
      },
      message: '巡检问题已按首次上报记录',
    }
  }
  const diffs: string[] = []
  if (hasValue(payload.problems) && payload.problems.trim() !== firstProblems) {
    diffs.push(`后续上报问题差异「${payload.problems.trim()}」`)
  }
  const firstDetail = String(current.上报明细 ?? '').trim()
  if (hasValue(payload.detail) && payload.detail.trim() !== firstDetail) {
    diffs.push(`后续上报明细差异「${payload.detail.trim()}」`)
  }
  const stamp = new Date().toISOString().slice(0, 16)
  const note = diffs.length > 0 ? `重复上报(${stamp})：${diffs.join('，')}，以首次上报为准` : `重复上报(${stamp})：内容一致，以首次上报为准`
  return {
    row: {
      ...current,
      status: PATROL_STATUS.reported,
      pending: false,
      abnormal: true,
      上报次数: Number(current.上报次数 ?? 1) + 1,
      备注: appendPatrolRemark(current, note),
    },
    message: diffs.length > 0 ? '重复上报：仅首次内容有效，差异已记入备注' : '重复上报：内容与首次一致，未改动首报内容',
  }
}

function mapStatus(text: string): string {
  if (text.includes('上报')) {
    return PATROL_STATUS.reported
  }
  if (text.includes('完成')) {
    return PATROL_STATUS.done
  }
  if (text.includes('巡检中')) {
    return PATROL_STATUS.running
  }
  if (text.includes('确认')) {
    return PATROL_STATUS.waitingConfirm
  }
  return PATROL_STATUS.pending
}

/** CSV/TSV 解析：支持带表头（表头需含「巡检编号」）或按固定列顺序的无表头文本。 */
export function parseImportText(text: string): { values: Record<string, string>[]; errors: string[] } {
  const errors: string[] = []
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '')
  if (lines.length === 0) {
    return { values: [], errors: ['导入内容为空'] }
  }
  const split = (line: string) => (line.includes('\t') ? line.split('\t') : line.split(','))
  const firstCells = split(lines[0]).map((cell) => cell.trim())
  const hasHeader = firstCells.includes('巡检编号')
  const header = hasHeader ? firstCells : [...PATROL_FIELDS]
  const dataLines = hasHeader ? lines.slice(1) : lines
  const values: Record<string, string>[] = []
  dataLines.forEach((line, index) => {
    const cells = split(line).map((cell) => cell.trim().replace(/^"|"$/g, ''))
    const record: Record<string, string> = {}
    cells.forEach((cell, i) => {
      const key = header[i]
      if (key) {
        record[key] = cell
      }
    })
    if (!hasValue(record['巡检编号'])) {
      errors.push(`第${index + (hasHeader ? 2 : 1)}行缺少巡检编号，无法与台账对应，已剔除`)
      return
    }
    values.push(record)
  })
  return { values, errors }
}

/** 生成搬入预案：不写台账，只产出「新增/台账对齐」的差异明细。 */
export function planImport(existing: EntryRow[], values: Record<string, string>[]): PatrolImportPreview {
  const errors: string[] = []
  const drafts: PatrolDraft[] = []
  // 文件内编号重复属于阻断项：重复的整组都不进预案，避免半条入库。
  const codeCount = new Map<string, number>()
  for (const record of values) {
    const code = String(record['巡检编号'] ?? '').trim()
    codeCount.set(code, (codeCount.get(code) ?? 0) + 1)
  }
  const nextId = existing.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0)
  values.forEach((record, index) => {
    const code = String(record['巡检编号']).trim()
    if ((codeCount.get(code) ?? 0) > 1) {
      if (!errors.some((err) => err.includes(`巡检编号 ${code} `))) {
        errors.push(`巡检编号 ${code} 在导入文件中重复（出现 ${codeCount.get(code)} 次），相关行已整组阻断`)
      }
      return
    }
    const built = buildDraftRow(record, nextId + drafts.length + 1)
    const old = existing.find((row) => String(row.巡检编号 ?? '') === code)
    if (old) {
      const differences = diffFields(old, built.row)
      drafts.push({ row: built.row, op: '台账对齐', missing: built.missing, differences })
    } else {
      drafts.push({ row: built.row, op: '新增', missing: built.missing, differences: [] })
    }
  })
  return { drafts, errors }
}

function buildDraftRow(values: Record<string, string>, id: number): { row: EntryRow; missing: string[] } {
  const missing: string[] = []
  const row: EntryRow = { id, status: '', pending: true, abnormal: false }
  for (const field of PATROL_FIELDS) {
    const text = values[field]?.trim() ?? ''
    if (hasValue(text)) {
      row[field] = text
    }
  }
  for (const field of VALUE_FIELDS) {
    if (!hasValue(values[field])) {
      missing.push(field)
    }
  }
  if (!hasValue(values['发现问题数'])) {
    row.发现问题数 = 0
    missing.push('发现问题数')
  } else {
    const num = Number(values['发现问题数'])
    row.发现问题数 = Number.isFinite(num) ? num : 0
    if (!Number.isFinite(num)) {
      missing.push('发现问题数（原值不可解析，暂记0）')
    }
  }
  const mappedStatus = mapStatus(values['巡检状态']?.trim() ?? '')
  row.status = missing.length > 0 ? PATROL_STATUS.waitingConfirm : mappedStatus
  row.pending = row.status !== PATROL_STATUS.done && row.status !== PATROL_STATUS.reported
  row.abnormal = row.status === PATROL_STATUS.reported
  if (missing.length > 0) {
    row.缺失字段 = missing.join('、')
    row.备注 = `往期数据搬入：缺失「${missing.join('、')}」，待人工确认补录`
  } else {
    row.备注 = `往期数据搬入（巡检日期 ${String(row.巡检日期)}）`
  }
  return { row, missing }
}

function diffFields(old: EntryRow, incoming: EntryRow): string[] {
  const diffs: string[] = []
  for (const field of PATROL_FIELDS) {
    const left = String(old[field] ?? '').trim()
    const right = String(incoming[field] ?? '').trim()
    if (right !== '' && left !== '' && left !== right) {
      diffs.push(`${field}: 台账「${left}」/ 导入「${right}」`)
    }
  }
  return diffs
}

/** 提交预案：按巡检日期排序后整体写入，落库失败由存储层抛错，调用方整套退回。 */
export function commitImport(existing: EntryRow[], preview: PatrolImportPreview): { rows: EntryRow[]; result: PatrolCommitResult } {
  const rows = [...existing]
  let inserted = 0
  let aligned = 0
  const reconciliation: string[] = []
  // 往期数据按巡检日期整体搬入。
  const ordered = [...preview.drafts].sort((a, b) =>
    String(a.row.巡检日期 ?? '').localeCompare(String(b.row.巡检日期 ?? '')),
  )
  for (const draft of ordered) {
    const idx = rows.findIndex((row) => String(row.巡检编号 ?? '') === String(draft.row.巡检编号))
    if (idx >= 0) {
      const merged: EntryRow = { ...rows[idx] }
      const notes: string[] = []
      // 导入明细与台账现状保持一致：以台账已有内容为准，导入差异只进备注。
      for (const diff of draft.differences) {
        notes.push(`往期搬入差异未覆盖台账，${diff}`)
      }
      if (draft.missing.length > 0) {
        notes.push(`导入缺失「${draft.missing.join('、')}」，待人工确认`)
      }
      if (notes.length > 0) {
        merged.备注 = appendPatrolRemark(merged, notes.join('；'))
        merged.缺失字段 = Array.from(new Set([String(merged.缺失字段 ?? ''), draft.missing.join('、')].filter(Boolean).flatMap((v) => v.split('、')))).join('、')
        if (!merged.缺失字段) {
          delete merged.缺失字段
        }
        merged.status = String(merged.缺失字段 ?? '') ? PATROL_STATUS.waitingConfirm : merged.status
        merged.pending = merged.status !== PATROL_STATUS.done && merged.status !== PATROL_STATUS.reported
      }
      rows[idx] = merged
      aligned += 1
      reconciliation.push(`对齐 ${String(draft.row.巡检编号)}：台账内容保持不变，差异${draft.differences.length}条已记备注`)
    } else {
      rows.push(draft.row)
      inserted += 1
      reconciliation.push(`新增 ${String(draft.row.巡检编号)}：${draft.missing.length > 0 ? `缺失「${draft.missing.join('、')}」待确认` : '字段完整'}`)
    }
  }
  const pendingConfirm = rows.filter((row) => row.status === PATROL_STATUS.waitingConfirm).length
  return { rows, result: { inserted, aligned, pendingConfirm, reconciliation } }
}

/** 人工补录确认：缺失字段补齐后恢复流转。 */
export function confirmPatrolRow(row: EntryRow, fills: Record<string, string>): EntryRow {
  const next: EntryRow = { ...row }
  for (const [field, value] of Object.entries(fills)) {
    if (hasValue(value)) {
      next[field] = value.trim()
    }
  }
  const stillMissing = VALUE_FIELDS.filter((field) => !hasValue(next[field]))
  if (stillMissing.length > 0) {
    next.缺失字段 = stillMissing.join('、')
    next.status = PATROL_STATUS.waitingConfirm
    next.pending = true
    return next
  }
  delete next.缺失字段
  next.备注 = appendPatrolRemark(next, '缺失字段已人工确认补录')
  next.status = PATROL_STATUS.pending
  next.pending = true
  return next
}

export function missingFieldsOf(row: EntryRow): string[] {
  return String(row.缺失字段 ?? '').split('、').map((v) => v.trim()).filter(Boolean)
}

export { REQUIRED_FIELDS }
