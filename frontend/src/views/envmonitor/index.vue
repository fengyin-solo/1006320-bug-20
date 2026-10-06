<template>
  <section class="page" data-module="envmonitor">
    <header class="page-head">
      <div>
        <h2>廊内环境监测管理</h2>
        <p class="page-desc">
          温度/湿度/氧气/有害气体走同一套判定口径（{{ limitText }}）；超标点位数按监测点位的最新记录重算，概览、列表与另存清单读同一份台账。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openReport()">上报监测读数</button>
        <button class="btn" type="button" @click="showImport = true">往期数据搬入</button>
        <button class="btn" type="button" @click="exportRows">另存清单(CSV)</button>
      </div>
    </header>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">监测点位数</span>
        <strong class="stat-value">{{ stats.pointsTotal }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">超标点位数(按点位重算)</span>
        <strong class="stat-value">{{ stats.overPoints }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">正常点位数</span>
        <strong class="stat-value">{{ stats.normalPoints }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">待采集 / 缺项待确认点位</span>
        <strong class="stat-value">{{ stats.waitingPoints }} / {{ stats.confirmPoints }}</strong>
      </article>    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }} 条
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
          <th>超标标记</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] === '' || row[column] == null ? '—' : row[column] }}</td>
          <td><span :class="['tag', statusTagClass(String(row.status))]">{{ row.status }}</span></td>
          <td>{{ row.abnormal ? '超标' : '正常' }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="openDetail(row)">详情</button>
            <button class="link" type="button" @click="openReport(String(row['监测点位']))">上报读数</button>
            <template v-if="String(row.status) === '待人工确认'">
              <button class="link" type="button" @click="openConfirm(row)">缺项确认</button>
            </template>
            <template v-else>
              <button class="link" type="button" @click="doJudge('判定正常', row)">确认正常</button>
              <button class="link" type="button" @click="doJudge('标记超标', row)">标记超标</button>
            </template>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无廊内环境监测数据，可先上报监测读数或搬入往期数据</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条监测记录 / {{ stats.recordsTotal }} 条未筛选记录</span>
      <span v-if="message" :class="messageOk ? 'success-text' : 'error-text'">{{ message }}</span>
    </footer>

    <!-- 详情面板：与列表同源，点确认正常后这里的读数、状态、超标标记一起变 -->
    <div v-if="detailRow" class="modal-mask" @click.self="detailRow = null">
      <div class="modal-box">
        <h3>监测记录详情 · #{{ detailRow.id }}</h3>
        <div class="detail-grid">
          <p><span>监测点位</span>{{ detailRow['监测点位'] }}</p>
          <p><span>采集时间</span>{{ detailRow['采集时间'] }}</p>
          <p><span>监测人员</span>{{ detailRow['监测人员'] }}</p>
          <p><span>环境温度(℃)</span>{{ detailRow['环境温度'] || '—' }}</p>
          <p><span>空气湿度(%RH)</span>{{ detailRow['空气湿度'] || '—' }}</p>
          <p><span>氧气浓度(%VOL)</span>{{ detailRow['氧气浓度'] || '—' }}</p>
          <p><span>有害气体</span>{{ detailRow['有害气体浓度'] || '—' }}</p>
          <p><span>当前状态</span><span :class="['tag', statusTagClass(String(detailRow.status))]">{{ detailRow.status }}</span></p>
          <p><span>超标标记</span>{{ detailRow.abnormal ? '超标' : '正常' }}</p>
          <p><span>数据来源</span>{{ detailRow['数据来源'] || '—' }}</p>
        </div>
        <p v-if="detailRow['备注']" class="page-desc">备注：{{ detailRow['备注'] }}</p>
        <div class="modal-foot">
          <button v-if="String(detailRow.status) === '待人工确认'" class="btn primary" type="button" @click="openConfirm(detailRow)">去缺项确认</button>
          <button class="btn" type="button" @click="detailRow = null">关闭</button>
        </div>
      </div>
    </div>

    <!-- 上报读数：同点位同时间重复上报只认第一次，差异只记备注 -->
    <div v-if="showReport" class="modal-mask" @click.self="showReport = false">
      <div class="modal-box">
        <h3>上报监测读数</h3>
        <div class="form-grid">
          <label><span>监测点位 *</span><input v-model="reportForm.point" placeholder="如 1号舱K0+100" /></label>
          <label><span>采集时间 *</span><input v-model="reportForm.collectedAt" placeholder="YYYY-MM-DD HH:mm" /></label>
          <label><span>环境温度(℃)</span><input v-model="reportForm.temperature" placeholder="5-32" /></label>
          <label><span>空气湿度(%RH)</span><input v-model="reportForm.humidity" placeholder="0-85" /></label>
          <label><span>氧气浓度(%VOL)</span><input v-model="reportForm.oxygen" placeholder="19.5-23.5" /></label>
          <label><span>有害气体浓度</span><input v-model="reportForm.harmful" placeholder="0-25" /></label>
          <label class="form-grid-wide"><span>监测人员</span><input v-model="reportForm.operator" placeholder="上报人" /></label>
        </div>
        <p class="page-desc">四项缺任一项会进「待人工确认」，不当作正常；重复上报不覆盖首次读数。</p>
        <div class="modal-foot">
          <button class="btn ghost" type="button" @click="showReport = false">取消</button>
          <button class="btn primary" type="button" @click="submitReport">提交上报</button>
        </div>
      </div>
    </div>

    <!-- 缺项逐条确认：只接受人工补录，补齐后仍按统一口径判定 -->
    <div v-if="confirmRow" class="modal-mask" @click.self="confirmRow = null">
      <div class="modal-box">
        <h3>缺项确认 · #{{ confirmRow.id }}（{{ confirmRow['监测点位'] }}）</h3>
        <p class="page-desc">
          处理方式：缺项不猜值、不自动沿用历史读数，一律人工逐条补录；补齐前记「待人工确认」，不计正常也不计超标。
          可点「取该点位上一笔读数」做参考，但必须人工确认后才入库。
        </p>
        <div class="form-grid">
          <label v-for="field in metricFields" :key="field">
            <span>{{ field }}（现值：{{ confirmRow[field] || '空' }}）</span>
            <input v-model="confirmForm[field]" :placeholder="`补录${field}`" />
            <button class="link" type="button" @click="usePrevious(field)">取该点位上一笔读数</button>
          </label>
        </div>
        <div class="modal-foot">
          <button class="btn ghost" type="button" @click="confirmRow = null">取消</button>
          <button class="btn primary" type="button" @click="submitConfirm">确认入库</button>
        </div>
      </div>
    </div>

    <!-- 往期数据按巡检日期整体搬入：任一明细致命错误整批退回 -->
    <div v-if="showImport" class="modal-mask" @click.self="showImport = false">
      <div class="modal-box">
        <h3>往期监测数据整体搬入</h3>
        <p class="page-desc">
          表头：监测点位,采集时间,环境温度,空气湿度,氧气浓度,有害气体浓度,监测人员。采集时间按巡检日期填写（YYYY-MM-DD）；
          落库失败整套退回；缺项逐条列入下方清单等人工确认，导入明细与台账保持一致。
        </p>
        <textarea v-model="importText" class="import-textarea" placeholder="监测点位,采集时间,环境温度,空气湿度,氧气浓度,有害气体浓度,监测人员&#10;1号舱K0+100,2026-09-10,26.1,68,20.8,9,李静"></textarea>
        <div v-if="importResult" class="detail-panel">
          <h3>搬入结果</h3>
          <p>{{ importResult.message }}</p>
          <ul v-if="importResult.missing && importResult.missing.length" class="missing-list">
            <li v-for="item in importResult.missing" :key="item.id">
              记录#{{ item.id }} {{ item.point }} {{ item.collectedAt }} 缺：{{ item.fields.join('、') }}
            </li>
          </ul>
        </div>
        <div class="modal-foot">
          <button class="btn ghost" type="button" @click="showImport = false">关闭</button>
          <button class="btn primary" type="button" @click="submitImport">整批搬入</button>
        </div>
      </div>
    </div>

    <HandoverPanel />
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { downloadEntries, listEntries, moduleMeta, runAction as applyAction } from '@/api/local-service'
import {
  confirmMissing,
  envStats,
  importEnvRows,
  reportEnvReading,
  type EnvImportResult,
  type EnvReadingInput,
} from '@/api/env-service'
import { ENV_METRIC_FIELDS, ENV_STATUS, envLimitText } from '@/data/env-rules'
import HandoverPanel from '@/components/HandoverPanel.vue'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('envmonitor')
const columns = ['监测编号', '监测点位', '环境温度', '空气湿度', '氧气浓度', '有害气体浓度', '采集时间', '监测人员', '监测状态', '备注']
const metricFields = [...ENV_METRIC_FIELDS]
const limitText = envLimitText()

const rows = ref<EntryRow[]>([])
const total = ref(0)
const message = ref('')
const messageOk = ref(false)
const filters = ref<Record<string, string>>({})
const filterFields = ['监测编号', '监测点位', '采集时间']

const statusSummary = computed(() =>
  [ENV_STATUS.waiting, ENV_STATUS.collected, ENV_STATUS.confirm, ENV_STATUS.normal, ENV_STATUS.over].map(
    (status) => ({ status, count: rows.value.filter((row) => String(row.status) === status).length }),
  ),
)

const stats = ref(envStats())

const detailRow = ref<EntryRow | null>(null)

const showReport = ref(false)
const emptyReport = (): EnvReadingInput => ({
  point: '',
  temperature: '',
  humidity: '',
  oxygen: '',
  harmful: '',
  collectedAt: '',
  operator: '',
})
const reportForm = ref<EnvReadingInput>(emptyReport())

const confirmRow = ref<EntryRow | null>(null)
const confirmForm = ref<Record<string, string>>({})

const showImport = ref(false)
const importText = ref('')
const importResult = ref<EnvImportResult | null>(null)

function flash(text: string, ok = false) {
  message.value = text
  messageOk.value = ok
}

function statusTagClass(status: string): string {
  if (status === ENV_STATUS.normal) return 'ok'
  if (status === ENV_STATUS.over) return 'bad'
  if (status === ENV_STATUS.confirm) return 'confirm'
  return 'wait'
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openReport(point = '') {
  reportForm.value = { ...emptyReport(), point }
  showReport.value = true
}

function openDetail(row: EntryRow) {
  detailRow.value = row
}

function doJudge(action: string, row: EntryRow) {
  const result = applyAction(meta.key, Number(row.id), action)
  flash(result.message, result.ok)
  reload()
  if (detailRow.value && Number(detailRow.value.id) === Number(row.id)) {
    detailRow.value = rows.value.find((item) => Number(item.id) === Number(row.id)) ?? null
  }
}

function submitReport() {
  const result = reportEnvReading(reportForm.value)
  flash(result.message, result.ok)
  if (result.ok) {
    showReport.value = false
  }
  reload()
}

function openConfirm(row: EntryRow) {
  confirmRow.value = row
  confirmForm.value = {
    环境温度: String(row['环境温度'] ?? ''),
    空气湿度: String(row['空气湿度'] ?? ''),
    氧气浓度: String(row['氧气浓度'] ?? ''),
    有害气体浓度: String(row['有害气体浓度'] ?? ''),
  }
  detailRow.value = null
}

function usePrevious(field: string) {
  if (!confirmRow.value) {
    return
  }
  const point = String(confirmRow.value['监测点位'])
  const currentTime = String(confirmRow.value['采集时间'])
  const previous = rows.value
    .filter(
      (row) =>
        String(row['监测点位']) === point &&
        String(row['采集时间']) < currentTime &&
        String(row[field] ?? '').trim() !== '',
    )
    .sort((a, b) => String(b['采集时间']).localeCompare(String(a['采集时间'])))[0]
  if (previous) {
    confirmForm.value[field] = String(previous[field])
  } else {
    flash(`该点位没有可参考的上一笔${field}读数，请手工填写`, false)
  }
}

function submitConfirm() {
  if (!confirmRow.value) {
    return
  }
  const result = confirmMissing({
    id: Number(confirmRow.value.id),
    temperature: confirmForm.value['环境温度'] ?? '',
    humidity: confirmForm.value['空气湿度'] ?? '',
    oxygen: confirmForm.value['氧气浓度'] ?? '',
    harmful: confirmForm.value['有害气体浓度'] ?? '',
  })
  flash(result.message, result.ok)
  if (result.ok) {
    confirmRow.value = null
  }
  reload()
}

function submitImport() {
  importResult.value = importEnvRows(importText.value)
  flash(importResult.value.message, importResult.value.ok)
  if (importResult.value.ok) {
    importText.value = ''
  }
  reload()
}

function reload() {
  message.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    stats.value = envStats()
  } catch (error) {
    flash(error instanceof Error ? error.message : '廊内环境监测列表读取失败', false)
  }
}

onMounted(reload)
</script>
