import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, commit, listRows, resetRows } from '@/data/local-store'
import { ENV_KEY, envOverview } from '@/data/env-rules'
import { judgeEnvRecord } from './env-service'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

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

/** 环境监测动作入口：判定正常/标记超标必须走统一口径，禁止通用流转硬写状态。 */
export function runAction(key: string, id: number, action: string): ActionResult {
  if (key === ENV_KEY && (action === '判定正常' || action === '标记超标')) {
    return judgeEnvRecord(id, action === '判定正常' ? '指标正常' : '指标超标')
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
  const result = commit((draft) => {
    draft.entries[key][index] = updated
  })
  if (!result.ok) {
    return { ok: false, message: `落库失败，已整套退回：${result.error.message}` }
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

/** 另存清单：读的是台账当前同一份数据，超标标记随记录状态实时带出。 */
export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态', '超标标记']
  const lines = [header.map(csvCell).join(',')]
  for (const row of listRows(key)) {
    const flag = row.abnormal ? '超标' : '正常'
    lines.push(
      [row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status, flag].map(csvCell).join(','),
    )
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

/**
 * 概览汇总：异常量按各模块的当前记录重算，绝不做「点一次加一次」的累加。
 * 廊内环境监测这一格的待处理/异常量取自 envOverview 的点位口径，
 * 与环境监测页列表、看板、另存清单读到的是同一份判定结果（氧气浓度也在此统一口径内）。
 */
export function loadOverview(): OverviewResult {
  const rows = allRows()
  const envSummary = envOverview(rows[ENV_KEY] ?? [])
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    if (meta.key === ENV_KEY) {
      return {
        name: meta.name,
        created: entries.length,
        pending: envSummary.waitingPoints + envSummary.confirmPoints,
        abnormal: envSummary.overPoints,
      }
    }
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
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
