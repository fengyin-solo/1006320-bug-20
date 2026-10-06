import type { EntryRow, HandoverLine } from '@/data/types'

/**
 * 入廊作业审批结论 → 运维值班交接清单。
 * 两处入口读的是同一份文本（存放在当日自动生成的值班交接记录的「交接事项」里），
 * 任一入口写入都 upsert 同一行结论，保证两处内容一致，不存在一先一后两份。
 */

export const DUTY_KEY = 'duty'
export const ENTRY_KEY = 'entryapprove'
const AUTO_PREFIX = 'AUTO-DUTY'
const LINE_PREFIX = '【作业审批】'

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function nowText(): string {
  return new Date().toISOString().slice(0, 16).replace('T', ' ')
}

function autoCode(date: string): string {
  return `${AUTO_PREFIX}-${date}`
}

export function lineText(line: HandoverLine): string {
  return `${LINE_PREFIX}${line.applyId}｜${line.result}｜${line.time}｜${line.text}`
}

export function parseLines(notes: string): HandoverLine[] {
  return notes
    .split(/\n/)
    .map((raw) => raw.trim())
    .filter((line) => line.startsWith(LINE_PREFIX))
    .map((line) => {
      const body = line.slice(LINE_PREFIX.length)
      const [applyId, result, time, ...rest] = body.split('｜')
      return { applyId: applyId ?? '', result: result ?? '', time: time ?? '', text: rest.join('｜') }
    })
}

/** 把审批结论并入当日自动交接记录；同一申请只保留一条（按申请编号 upsert）。 */
export function upsertApprovalLine(dutyRows: EntryRow[], line: HandoverLine): EntryRow[] {
  const date = today()
  const code = autoCode(date)
  const rows = [...dutyRows]
  let idx = rows.findIndex((row) => String(row.交接编号 ?? '') === code)
  if (idx < 0) {
    const id = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
    rows.push({
      id,
      status: '待交接',
      pending: true,
      abnormal: false,
      交接编号: code,
      值班班组: '自动汇总',
      值班日期: date,
      班次: '全天',
      值班人员: '系统汇总',
      交接事项: '',
      交接人员: '系统汇总',
      交接状态: '待交接',
    })
    idx = rows.length - 1
  }
  const target = rows[idx]
  const lines = parseLines(String(target.交接事项 ?? ''))
  const kept = lines.filter((item) => item.applyId !== line.applyId)
  kept.push(line)
  kept.sort((a, b) => a.time.localeCompare(b.time))
  const head = String(target.交接事项 ?? '')
    .split(/\n/)
    .map((raw) => raw.trim())
    .filter((raw) => raw !== '' && !raw.startsWith(LINE_PREFIX))
  rows[idx] = { ...target, 交接事项: [...head, ...kept.map(lineText)].join('\n') }
  return rows
}

/** 两处入口共用的只读清单：入廊作业审批页与值班交接页看到的内容完全一致。 */
export function approvalHandoverLines(dutyRows: EntryRow[]): HandoverLine[] {
  const all: HandoverLine[] = []
  for (const row of dutyRows) {
    all.push(...parseLines(String(row.交接事项 ?? '')))
  }
  return all.sort((a, b) => b.time.localeCompare(a.time))
}

export function makeHandoverLine(applyId: string, result: string, text: string): HandoverLine {
  return { applyId, result, time: nowText(), text }
}
