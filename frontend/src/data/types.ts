/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** 廊内环境监测：按同一套阈值口径算出的判定结果，概览/列表/导出/动作都只准读这一份结论。 */
export type EnvEvaluation = {
  /** 四项取值是否都采集到了可解析的数值；任一项缺失或不可解析都算未采集。 */
  collected: boolean
  /** 是否存在超标项（含氧气浓度异常）。 */
  abnormal: boolean
  /** 逐项判定明细。 */
  items: { field: string; label: string; value: number | null; unit: string; abnormal: boolean; reason: string }[]
  /** 超标原因汇总，落库到「超标原因」字段。 */
  reasons: string[]
  missing: string[]
}

export type EnvMetrics = {
  totalPoints: number
  pendingPoints: number
  normalPoints: number
  abnormalPoints: number
}

/** 巡检往期数据搬入时的单行预案：commit 之前不碰台账，不产生中间态。 */
export type PatrolDraft = {
  row: EntryRow
  op: '新增' | '台账对齐'
  missing: string[]
  differences: string[]
}

export type PatrolImportPreview = {
  drafts: PatrolDraft[]
  /** 阻断入库的硬错误（编号重复、整行无法识别等）。 */
  errors: string[]
}

export type PatrolCommitResult = {
  inserted: number
  aligned: number
  pendingConfirm: number
  /** 入库后逐条对账明细，导入明细与台账现状按这份对齐。 */
  reconciliation: string[]
}

/** 写入值班交接清单的一条结论，入廊作业审批与运维值班交接两处读同一份文本。 */
export type HandoverLine = {
  applyId: string
  result: string
  time: string
  text: string
}
