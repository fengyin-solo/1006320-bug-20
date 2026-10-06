<template>
  <section class="page" data-module="patrol">
    <header class="page-head">
      <div>
        <h2>廊内巡检任务管理</h2>
        <p class="page-desc">重复上报只认第一次内容、差异只记备注；往期巡检按巡检日期整体搬入，缺失项逐条列出待人工确认，落库失败整套退回。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记巡检任务</button>
        <button class="btn" type="button" @click="importOpen = true">往期数据搬入</button>
        <button class="btn" type="button" @click="exportRows">导出廊内巡检任务清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">待巡检任务</span>
        <strong class="stat-value">{{ stats.pending }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">巡检中任务</span>
        <strong class="stat-value">{{ stats.running }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">待人工确认（缺项）</span>
        <strong class="stat-value" :class="{ 'stat-alert': stats.waiting > 0 }">{{ stats.waiting }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">已上报问题点</span>
        <strong class="stat-value">{{ stats.reported }}</strong>
      </article>
    </div>

    <p v-if="infoMessage" class="info-text">{{ infoMessage }}</p>
    <p v-if="errorMessage" class="error-text">{{ errorMessage }}</p>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)" :class="{ 'row-abnormal': row.abnormal }">
          <td v-for="column in columns" :key="column">{{ row[column] === '' || row[column] === undefined ? '—' : row[column] }}</td>
          <td>
            {{ row.status }}
            <span v-if="String(row.缺失字段 ?? '')" class="tag tag-warn">缺项待确认</span>
          </td>
          <td class="row-actions">
            <button
              v-for="action in actionsFor(row)"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无廊内巡检任务数据，可先登记巡检任务</td>
        </tr>
      </tbody>
    </table>

    <!-- 上报问题：首报登记内容；重复上报只读首报，差异追加备注 -->
    <div v-if="reportTarget" class="modal-mask" @click.self="reportTarget = null">
      <div class="modal-panel">
        <header class="modal-head">
          <h3>上报巡检问题 · {{ String(reportTarget.巡检编号) }}</h3>
          <button class="btn ghost" type="button" @click="reportTarget = null">关闭</button>
        </header>
        <template v-if="String(reportTarget.上报问题 ?? '')">
          <p class="info-text">该任务已有首次上报，重复上报只认第一次内容，本次差异仅追加到备注。</p>
          <p class="detail-note">首次上报问题：{{ reportTarget.上报问题 }}</p>
          <p class="detail-note">首次上报明细：{{ reportTarget.上报明细 || '—' }}</p>
          <p class="detail-note">已上报次数：{{ Number(reportTarget.上报次数 ?? 1) }}</p>
        </template>
        <label class="modal-field">
          <span>发现问题（{{ String(reportTarget.上报问题 ?? '') ? '本次内容，不覆盖首报' : '首次上报，落库后不可改' }}）</span>
          <textarea v-model="reportForm.problems" rows="3" placeholder="例如：2号电力舱支架锈蚀"></textarea>
        </label>
        <label class="modal-field">
          <span>问题明细</span>
          <textarea v-model="reportForm.detail" rows="3" placeholder="位置、程度、建议措施"></textarea>
        </label>
        <div class="collect-actions">
          <button class="btn primary" type="button" @click="submitReport">确认上报</button>
        </div>
      </div>
    </div>

    <!-- 往期数据搬入 -->
    <div v-if="importOpen" class="modal-mask" @click.self="importOpen = false">
      <div class="modal-panel modal-wide">
        <header class="modal-head">
          <h3>往期巡检数据搬入</h3>
          <button class="btn ghost" type="button" @click="importOpen = false">关闭</button>
        </header>
        <p class="detail-note">
          列顺序：巡检编号、巡检路线、巡检班组、巡检日期、计划日期、完成时间、发现问题数、巡检人员、巡检状态。
          支持 CSV/TSV，可带表头。先预览缺失项，确认后整套落库；落库失败整套退回，不产生中间态。
        </p>
        <textarea v-model="importText" rows="6" class="import-area" placeholder="粘贴往期明细，或用下方按钮选择文件"></textarea>
        <div class="collect-actions">
          <input ref="fileInput" type="file" accept=".csv,.txt,.tsv" hidden @change="onFile" />
          <button class="btn" type="button" @click="fileInput?.click()">选择文件</button>
          <button class="btn primary" type="button" @click="buildPreview">生成搬入预案</button>
        </div>

        <p v-for="(err, i) in importErrors" :key="`e-${i}`" class="error-text">{{ err }}</p>

        <table v-if="preview" class="data-table">
          <thead>
            <tr><th>处理</th><th>巡检编号</th><th>巡检日期</th><th>巡检班组</th><th>缺失项</th><th>与台账差异</th></tr>
          </thead>
          <tbody>
            <tr v-for="(draft, i) in preview.drafts" :key="`d-${i}`">
              <td>{{ draft.op }}</td>
              <td>{{ draft.row.巡检编号 }}</td>
              <td>{{ draft.row.巡检日期 || '—' }}</td>
              <td>{{ draft.row.巡检班组 || '—' }}</td>
              <td>
                <span v-if="draft.missing.length" class="tag tag-warn">{{ draft.missing.join('、') }}</span>
                <span v-else class="tag tag-ok">完整</span>
              </td>
              <td>
                <ul v-if="draft.differences.length" class="diff-list">
                  <li v-for="(d, j) in draft.differences" :key="j">{{ d }}（保留台账值）</li>
                </ul>
                <span v-else>—</span>
              </td>
            </tr>
          </tbody>
        </table>

        <div v-if="preview" class="collect-actions">
          <button class="btn primary" type="button" :disabled="!!preview.errors.length" @click="doImport">
            确认整套搬入（{{ preview.drafts.length }} 条）
          </button>
        </div>

        <div v-if="commitResult" class="reconcile-box">
          <h4>入库对账（导入明细与台账现状按此一致）</h4>
          <ul>
            <li v-for="(line, i) in commitResult.reconciliation" :key="i">{{ line }}</li>
          </ul>
        </div>
      </div>
    </div>

    <!-- 缺项人工确认补录 -->
    <div v-if="fillTarget" class="modal-mask" @click.self="fillTarget = null">
      <div class="modal-panel">
        <header class="modal-head">
          <h3>缺失项人工确认 · {{ String(fillTarget.巡检编号) }}</h3>
          <button class="btn ghost" type="button" @click="fillTarget = null">关闭</button>
        </header>
        <p class="detail-note">缺项处理方式：不臆造、不内插，由人工在下方逐条补录；补全前任务保持「待确认」，不计入正常统计。</p>
        <label v-for="field in fillFields" :key="field" class="modal-field">
          <span>{{ field }}</span>
          <input v-model="fillForm[field]" :placeholder="`请补录${field}`" />
        </label>
        <div class="collect-actions">
          <button class="btn primary" type="button" @click="submitFill">确认补录</button>
        </div>
      </div>
    </div>

    <footer class="page-foot">
      <span>共 {{ total }} 条巡检任务</span>
      <a class="link" href="/docs/处理说明.md" @click.prevent="showGuide = !showGuide">{{ showGuide ? '收起处理说明' : '查看处理说明' }}</a>
    </footer>
    <details v-if="showGuide" class="guide-box">
      <summary>巡检链路处理说明（摘要，全文见 docs/处理说明.md）</summary>
      <ul>
        <li>重复上报：首次上报内容锁定，后续任何差异只追加备注，首报字段不被覆盖。</li>
        <li>往期搬入：按巡检日期排序整体入库；缺失字段逐条列入「缺失字段」，暂不补值，等人工确认。</li>
        <li>同编号记录以台账现状为准，导入差异只记备注；整套落库失败时全部退回。</li>
      </ul>
    </details>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  commitPatrolImport,
  confirmPatrolMissing,
  downloadEntries,
  listEntries,
  moduleMeta,
  patrolReport,
  previewPatrolImport,
  runAction as applyAction,
} from '@/api/local-service'
import { missingFieldsOf, PATROL_STATUS } from '@/domain/patrol'
import type { EntryRow, PatrolCommitResult, PatrolImportPreview } from '@/data/types'

const meta = moduleMeta('patrol')
const columns = ['巡检编号', '巡检路线', '巡检班组', '巡检日期', '计划日期', '完成时间', '发现问题数', '巡检人员', '缺失字段', '巡检状态']
const statuses = ['待巡检', '巡检中', '已完成', '已上报', '待确认']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const infoMessage = ref('')
const showGuide = ref(false)
const filters = ref<Record<string, string>>({})
const filterFields = ['巡检编号', '巡检路线', '巡检班组']

const reportTarget = ref<EntryRow | null>(null)
const reportForm = ref({ problems: '', detail: '' })
const importOpen = ref(false)
const importText = ref('')
const importErrors = ref<string[]>([])
const preview = ref<PatrolImportPreview | null>(null)
const commitResult = ref<PatrolCommitResult | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const fillTarget = ref<EntryRow | null>(null)
const fillFields = ref<string[]>([])
const fillForm = ref<Record<string, string>>({})

const stats = computed(() => ({
  pending: rows.value.filter((row) => row.status === PATROL_STATUS.pending).length,
  running: rows.value.filter((row) => row.status === PATROL_STATUS.running).length,
  waiting: rows.value.filter((row) => row.status === PATROL_STATUS.waitingConfirm).length,
  reported: rows.value.filter((row) => row.status === PATROL_STATUS.reported).length,
}))

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function actionsFor(row: EntryRow): string[] {
  if (String(row.status) === PATROL_STATUS.waitingConfirm) {
    return ['补录确认']
  }
  const base = ['开始巡检', '确认完成', '上报问题']
  return base
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '巡检任务登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  infoMessage.value = ''
  if (action === '上报问题') {
    reportTarget.value = row
    reportForm.value = { problems: '', detail: '' }
    return
  }
  if (action === '补录确认') {
    fillTarget.value = row
    fillFields.value = missingFieldsOf(row)
    fillForm.value = Object.fromEntries(fillFields.value.map((field) => [field, '']))
    return
  }
  // 其余通用动作仍走统一流转。
  const result = applyAction(meta.key, Number(row.id), action)
  if (result.ok) {
    infoMessage.value = result.message
  } else {
    errorMessage.value = result.message
  }
  reload()
}

function submitReport() {
  if (!reportTarget.value) {
    return
  }
  if (!reportForm.value.problems.trim()) {
    errorMessage.value = '请填写发现问题后再上报'
    return
  }
  const result = patrolReport(Number(reportTarget.value.id), reportForm.value.problems, reportForm.value.detail)
  if (result.ok) {
    infoMessage.value = result.message
    reportTarget.value = null
  } else {
    errorMessage.value = result.message
  }
  reload()
}

function onFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) {
    return
  }
  const reader = new FileReader()
  reader.onload = () => {
    importText.value = String(reader.result ?? '')
    importErrors.value = []
    preview.value = null
    commitResult.value = null
  }
  reader.readAsText(file, 'utf-8')
}

function buildPreview() {
  errorMessage.value = ''
  const result = previewPatrolImport(importText.value)
  importErrors.value = [...result.parseErrors, ...result.errors]
  preview.value = { drafts: result.drafts, errors: result.errors }
  commitResult.value = null
  if (result.errors.length) {
    errorMessage.value = `预案存在 ${result.errors.length} 条阻断项，修正后才能搬入`
  } else {
    infoMessage.value = `预案生成：新增/对齐共 ${result.drafts.length} 条，请核对缺失项后确认`
  }
}

function doImport() {
  if (!preview.value) {
    return
  }
  const result = commitPatrolImport(preview.value)
  if (result.ok && result.result) {
    infoMessage.value = result.message
    commitResult.value = result.result
    importOpen.value = false
    preview.value = null
    importText.value = ''
    reload()
  } else {
    errorMessage.value = result.message
  }
}

function submitFill() {
  if (!fillTarget.value) {
    return
  }
  const result = confirmPatrolMissing(Number(fillTarget.value.id), fillForm.value)
  if (result.ok) {
    infoMessage.value = result.message
    fillTarget.value = null
    reload()
  } else {
    errorMessage.value = result.message
  }
}

function reload() {
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '廊内巡检任务列表读取失败'
  }
}

onMounted(reload)
</script>
