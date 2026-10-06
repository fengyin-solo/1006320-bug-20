import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, commitRows, listRows, resetRows, saveRows } from '@/data/local-store'
import {
  ENV_FIELDS,
  ENV_STATUS,
  appendRemark,
  applyEvaluation,
  envMetrics,
  evaluateReading,
} from '@/domain/env'
import {
  commitImport,
  confirmPatrolRow,
  parseImportText,
  planImport,
  reportIssue,
} from '@/domain/patrol'
import {
  approvalHandoverLines,
  makeHandoverLine,
  upsertApprovalLine,
} from '@/domain/handover'
import type {
  ActionResult,
  EntryRow,
  HandoverLine,
  ModuleMeta,
  OverviewResult,
  PageResult,
  PatrolCommitResult,
  PatrolImportPreview,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function getEntry(key: string, id: number): EntryRow | undefined {
  return listRows(key).find((row) => Number(row.id) === id)
}

function findRow(meta: ModuleMeta, rows: EntryRow[], id: number) {
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { index: -1, row: undefined as EntryRow | undefined }
  }
  return { index, row: rows[index] }
}

/* ---------------- 廊内环境监测 ---------------- */

export type EnvReadings = Partial<Record<(typeof ENV_FIELDS)[keyof typeof ENV_FIELDS], string>>

function withEnvRow(id: number, fn: (row: EntryRow) => EntryRow): ActionResult {
  const meta = moduleMeta('envmonitor')
  const rows = listRows(meta.key)
  const { index, row } = findRow(meta, rows, id)
  if (!row) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  try {
    const next = fn(row)
    const copy = [...rows]
    copy[index] = next
    saveRows(meta.key, copy)
    return { ok: true, message: `${meta.entity}已更新，当前状态「${next.status}」` }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '监测记录保存失败' }
  }
}

/** 提交采集：温度/湿度/氧气/有害气体与超标标记、状态一次性改写，判定只走统一口径。 */
export function submitEnvCollection(id: number, readings: EnvReadings): ActionResult {
  return withEnvRow(id, (row) => {
    const merged: EntryRow = { ...row }
    for (const field of Object.values(ENV_FIELDS)) {
      const value = readings[field]
      if (value !== undefined && value.trim() !== '') {
        merged[field] = value.trim()
      }
    }
    merged.采集时间 = new Date().toISOString().slice(0, 16).replace('T', ' ')
    const evalResult = evaluateReading(merged)
    if (!evalResult.collected) {
      throw new Error(`采集不完整，仍缺：${evalResult.missing.join('、')}`)
    }
    return applyEvaluation(merged, evalResult, `采集提交：${evalResult.abnormal ? evalResult.reasons.join('；') : '四项指标均在阈值内'}`)
  })
}

/**
 * 确认正常（幂等）：
 * 记录当前判定就是正常时直接返回提示，不再重复扣减超标点位数；
 * 实测仍超标时拒绝改写，防止状态与数值两张皮。
 */
export function confirmEnvNormal(id: number): ActionResult {
  const rows = listRows('envmonitor')
  const target = rows.find((row) => Number(row.id) === id)
  if (!target) {
    return { ok: false, message: `没有找到编号为 ${id} 的环境监测记录` }
  }
  const evalResult = evaluateReading(target)
  if (!evalResult.collected) {
    return { ok: false, message: '取值未采集完整，不能确认为正常' }
  }
  if (evalResult.abnormal) {
    return { ok: false, message: `实测仍超标（${evalResult.reasons.join('；')}），不能判定正常` }
  }
  if (String(target.status) === ENV_STATUS.normal && !target.abnormal) {
    // 同一点位再点一次确认：什么都不改，异常数自然不会被减第二回。
    return { ok: true, message: '该点位已是指标正常，无需重复确认' }
  }
  return withEnvRow(id, (row) => applyEvaluation(row, evaluateReading(row), '人工确认：指标正常，超标标记已清除'))
}

/** 标记超标：记录与超标标记一起改写；若按口径实测正常则拒绝。 */
export function markEnvOver(id: number): ActionResult {
  const target = listRows('envmonitor').find((row) => Number(row.id) === id)
  if (!target) {
    return { ok: false, message: `没有找到编号为 ${id} 的环境监测记录` }
  }
  const evalResult = evaluateReading(target)
  if (!evalResult.collected) {
    return { ok: false, message: '取值未采集完整，不能标记超标' }
  }
  if (!evalResult.abnormal) {
    return { ok: false, message: '按统一阈值口径四项指标均正常，不能标记超标' }
  }
  return withEnvRow(id, (row) => applyEvaluation(row, evaluateReading(row), `人工标记超标：${evalResult.reasons.join('；')}`))
}

export function envSummary() {
  return envMetrics(listRows('envmonitor'))
}

/* ---------------- 廊内巡检任务 ---------------- */

export function patrolReport(id: number, problems: string, detail: string): ActionResult {
  const meta = moduleMeta('patrol')
  const rows = listRows(meta.key)
  const { index, row } = findRow(meta, rows, id)
  if (!row) {
    return { ok: false, message: `没有找到编号为 ${id} 的巡检任务` }
  }
  try {
    const { row: next, message } = reportIssue(row, { problems, detail })
    const copy = [...rows]
    copy[index] = next
    saveRows(meta.key, copy)
    return { ok: true, message }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '问题上报失败' }
  }
}

/** 往期数据搬入：先生成预案（不落库），缺失项逐条列出。 */
export function previewPatrolImport(text: string): PatrolImportPreview & { parseErrors: string[] } {
  const { values, errors } = parseImportText(text)
  const preview = planImport(listRows('patrol'), values)
  return { ...preview, parseErrors: errors }
}

/** 预案确认后整套提交；落库失败由存储层抛错，已在存储层回滚快照，这里不补写任何字段。 */
export function commitPatrolImport(preview: PatrolImportPreview): { ok: boolean; message: string; result?: PatrolCommitResult } {
  try {
    const { rows, result } = commitImport(listRows('patrol'), preview)
    saveRows('patrol', rows)
    return {
      ok: true,
      message: `往期巡检数据已整体搬入：新增 ${result.inserted} 条、台账对齐 ${result.aligned} 条、待人工确认 ${result.pendingConfirm} 条`,
      result,
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '导入落库失败，整套已退回' }
  }
}

export function confirmPatrolMissing(id: number, fills: Record<string, string>): ActionResult {
  const meta = moduleMeta('patrol')
  const rows = listRows(meta.key)
  const { index, row } = findRow(meta, rows, id)
  if (!row) {
    return { ok: false, message: `没有找到编号为 ${id} 的巡检任务` }
  }
  try {
    const next = confirmPatrolRow(row, fills)
    const copy = [...rows]
    copy[index] = next
    saveRows(meta.key, copy)
    const still = String(next.缺失字段 ?? '')
    return still
      ? { ok: false, message: `仍缺「${still}」，请补齐后再确认` }
      : { ok: true, message: '缺失项已人工确认，任务回到待巡检' }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '补录失败' }
  }
}

/* ---------------- 入廊作业审批 × 值班交接 ---------------- */

function entryHandover(row: EntryRow, result: string): HandoverLine {
  const text = `${String(row.申请单位 ?? '')}在${String(row.作业舱室 ?? '')}的${String(row.作业类型 ?? '')}作业，审批结论：${result}`
  return makeHandoverLine(String(row.申请编号 ?? ''), result, text)
}

export function entryAction(id: number, action: string): ActionResult {
  const meta = moduleMeta('entryapprove')
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(meta.key)
  const { index, row } = findRow(meta, rows, id)
  if (!row) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  if (String(row.status) === target) {
    return { ok: false, message: `该申请已是「${target}」，不用重复操作` }
  }
  const updated: EntryRow = {
    ...row,
    status: target,
    pending: target !== '已完工',
    abnormal: false,
    审批结论: target === '已批准' ? '批准' : target === '已驳回' ? '驳回' : '完工',
  }
  updated.备注 = appendRemark(updated, `审批流转：${action}，结论已同步值班交接清单`)
  const nextEntries = [...rows]
  nextEntries[index] = updated
  const nextDuty = upsertApprovalLine(listRows('duty'), entryHandover(updated, updated.审批结论 as string))
  try {
    // 审批记录与交接清单整套提交：任一落库失败两处都不改。
    commitRows({ entryapprove: nextEntries, duty: nextDuty })
    return { ok: true, message: `申请已${action}，审批结论已写入值班交接清单（两处同一份）` }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '审批落库失败，整套已退回' }
  }
}

export function handoverEntries(): HandoverLine[] {
  return approvalHandoverLines(listRows('duty'))
}

/* ---------------- 通用动作 ---------------- */

export function runAction(key: string, id: number, action: string): ActionResult {
  if (key === 'entryapprove') {
    return entryAction(id, action)
  }
  if (key === 'envmonitor') {
    if (action === '判定正常') {
      return confirmEnvNormal(id)
    }
    if (action === '标记超标') {
      return markEnvOver(id)
    }
  }
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  try {
    saveRows(key, next)
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '落库失败，变更已退回' }
  }
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

function csvCell(value: unknown): string {
  const text = String(value ?? '')
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    // 另存清单直接读台账当前值：超标判定/备注与列表、详情、概览同源，不残留旧标记。
    lines.push([row.id, ...meta.fields.map((field) => csvCell(row[field] ?? '')), csvCell(row.status)].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    let pending = entries.filter((row) => row.pending).length
    let abnormal = entries.filter((row) => row.abnormal).length
    if (meta.key === 'envmonitor') {
      // 氧气浓度与温湿度共用 evaluateReading 同一口径，概览不另算：按监测点位重算去重。
      const metrics = envMetrics(entries)
      pending = metrics.pendingPoints
      abnormal = metrics.abnormalPoints
    }
    if (meta.key === 'patrol') {
      abnormal = entries.filter((row) => String(row.status) === '已上报').length
      pending = entries.filter((row) => String(row.status) !== '已完成' && String(row.status) !== '已上报').length
    }
    return {
      name: meta.name,
      created: entries.length,
      pending,
      abnormal,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
