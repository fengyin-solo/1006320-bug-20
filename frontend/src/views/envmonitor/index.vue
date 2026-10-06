<template>
  <section class="page" data-module="envmonitor">
    <header class="page-head">
      <div>
        <h2>廊内环境监测管理</h2>
        <p class="page-desc">温度、湿度、氧气浓度、有害气体共用一套阈值口径；超标点位数按监测点位重算，确认正常后列表、概览、另存清单同步回落。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记环境监测记录</button>
        <button class="btn" type="button" @click="exportRows">导出廊内环境监测清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">监测点位总数</span>
        <strong class="stat-value">{{ metrics.totalPoints }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">待采集点位</span>
        <strong class="stat-value">{{ metrics.pendingPoints }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">指标正常点位</span>
        <strong class="stat-value">{{ metrics.normalPoints }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">超标点位数（按点位去重）</span>
        <strong class="stat-value" :class="{ 'stat-alert': metrics.abnormalPoints > 0 }">{{ metrics.abnormalPoints }}</strong>
      </article>
    </div>

    <p v-if="infoMessage" class="info-text">{{ infoMessage }}</p>
    <p v-if="errorMessage" class="error-text">{{ errorMessage }}</p>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }} 条记录
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
            <span v-if="String(row.缺失字段 ?? '')" class="tag tag-warn">待确认</span>
          </td>
          <td class="row-actions">
            <button class="link" type="button" @click="openDetail(row)">查看详情</button>
            <template v-for="action in actionsFor(row)" :key="action">
              <button class="link" type="button" @click="runAction(action, row)">{{ action }}</button>
            </template>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无廊内环境监测数据，可先登记环境监测记录</td>
        </tr>
      </tbody>
    </table>

    <div v-if="detail" class="modal-mask" @click.self="closeDetail">
      <div class="modal-panel">
        <header class="modal-head">
          <h3>监测详情 · {{ String(detail.row.监测点位) }}</h3>
          <button class="btn ghost" type="button" @click="closeDetail">关闭</button>
        </header>

        <table class="data-table detail-table">
          <tbody>
            <tr v-for="item in detail.eval.items" :key="item.field" :class="{ 'row-abnormal': item.abnormal }">
              <th>{{ item.label }}</th>
              <td>{{ item.value === null ? '未采集' : `${item.value} ${item.unit}` }}</td>
              <td>
                <span v-if="item.value === null" class="tag tag-warn">未采集</span>
                <span v-else-if="item.abnormal" class="tag tag-over">超标：{{ item.reason }}</span>
                <span v-else class="tag tag-ok">正常（{{ ruleText(item.field) }}）</span>
              </td>
            </tr>
          </tbody>
        </table>

        <p class="detail-note">
          当前记录状态：<strong>{{ detail.row.status }}</strong>
          ｜综合判定：
          <strong :class="detail.eval.abnormal ? 'error-text' : 'ok-text'">
            {{ !detail.eval.collected ? '未采集' : detail.eval.abnormal ? '超标' : '正常' }}
          </strong>
        </p>
        <p v-if="detail.eval.reasons.length" class="error-text">超标原因：{{ detail.eval.reasons.join('；') }}</p>
        <p v-if="String(detail.row.备注 ?? '')" class="detail-note">备注：{{ detail.row.备注 }}</p>

        <fieldset class="collect-box">
          <legend>补录 / 更新采集取值</legend>
          <div class="collect-grid">
            <label v-for="field in readingFields" :key="field.key">
              <span>{{ field.label }}（{{ ruleText(field.key) }}）</span>
              <input v-model="detail.form[field.key]" :placeholder="`输入${field.label}数值`" inputmode="decimal" />
            </label>
          </div>
          <div class="collect-actions">
            <button class="btn primary" type="button" @click="submitCollection(detail.row)">提交采集</button>
            <button class="btn" type="button" @click="confirmNormal(detail.row)">确认正常</button>
            <button class="btn" type="button" @click="markOver(detail.row)">标记超标</button>
          </div>
        </fieldset>
      </div>
    </div>

    <footer class="page-foot">
      <span>共 {{ total }} 条监测记录，{{ metrics.totalPoints }} 个监测点位（同点位取最新采集）</span>
      <a class="link" href="/docs/处理说明.md" @click.prevent="showGuide = !showGuide">{{ showGuide ? '收起处理说明' : '查看处理说明' }}</a>
    </footer>
    <details v-if="showGuide" class="guide-box">
      <summary>环境监测链路处理说明（摘要，全文见 docs/处理说明.md）</summary>
      <ul>
        <li>确认正常同时改写监测记录与超标标记，概览、列表、另存清单读同一份台账。</li>
        <li>超标点位数按监测点位去重重算，不累加；重复确认幂等，不再扣减第二回。</li>
        <li>氧气浓度（19.5%~23.5%VOL）与温湿度同一口径，概览不另算。</li>
        <li>早年「未采集」被写成「指标正常」的存量记录：取值无法解析即退回待采集并备注，等人工重采。</li>
      </ul>
    </details>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  envSummary,
  getEntry,
  listEntries,
  markEnvOver,
  moduleMeta,
  runAction as applyAction,
  submitEnvCollection,
  type EnvReadings,
} from '@/api/local-service'
import { ENV_FIELDS, ENV_STATUS, evaluateReading } from '@/domain/env'
import type { EntryRow, EnvEvaluation } from '@/data/types'

const meta = moduleMeta('envmonitor')
const columns = ['监测编号', '监测点位', '环境温度', '空气湿度', '氧气浓度', '有害气体浓度', '采集时间', '超标判定', '超标原因']
const readingFields = [
  { key: ENV_FIELDS.temperature, label: '环境温度' },
  { key: ENV_FIELDS.humidity, label: '空气湿度' },
  { key: ENV_FIELDS.oxygen, label: '氧气浓度' },
  { key: ENV_FIELDS.harmfulGas, label: '有害气体浓度' },
] as const

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const infoMessage = ref('')
const showGuide = ref(false)
const filters = ref<Record<string, string>>({})
const filterFields = ['监测编号', '监测点位']
const statuses = ['待采集', '已采集', '指标正常', '指标超标']

const metrics = ref(envSummary())

type DetailState = {
  row: EntryRow
  eval: EnvEvaluation
  form: Record<string, string>
}
const detail = ref<DetailState | null>(null)

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const RULE_TEXT: Record<string, string> = {
  [ENV_FIELDS.temperature]: '5~32℃',
  [ENV_FIELDS.humidity]: '0~85%RH',
  [ENV_FIELDS.oxygen]: '19.5~23.5%VOL',
  [ENV_FIELDS.harmfulGas]: '0~10ppm',
}
function ruleText(key: string): string {
  return RULE_TEXT[key] ?? ''
}

function actionsFor(row: EntryRow): string[] {
  switch (String(row.status)) {
    case ENV_STATUS.pending:
      return ['提交采集']
    case ENV_STATUS.collected:
      return ['判定正常', '标记超标']
    case ENV_STATUS.normal:
      return ['标记超标']
    case ENV_STATUS.over:
      return ['判定正常']
    default:
      return ['判定正常', '标记超标']
  }
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '环境监测记录登记入口尚未接入审批流'
}

function flash(result: { ok: boolean; message: string }) {
  if (result.ok) {
    infoMessage.value = result.message
    errorMessage.value = ''
  } else {
    errorMessage.value = result.message
    infoMessage.value = ''
  }
}

function runAction(action: string, row: EntryRow) {
  if (action === '提交采集') {
    openDetail(row)
    return
  }
  flash(applyAction(meta.key, Number(row.id), action))
  reload()
}

function openDetail(row: EntryRow) {
  const latest = getEntry(meta.key, Number(row.id)) ?? row
  const form: Record<string, string> = {}
  for (const field of readingFields) {
    form[field.key] = String(latest[field.key] ?? '').replace(/[^\d.-]/g, '')
  }
  detail.value = { row: latest, eval: evaluateReading(latest), form }
}

function closeDetail() {
  detail.value = null
}

function refreshDetail() {
  if (!detail.value) {
    return
  }
  const latest = getEntry(meta.key, Number(detail.value.row.id))
  if (latest) {
    detail.value = { ...detail.value, row: latest, eval: evaluateReading(latest) }
  }
}

function submitCollection(row: EntryRow) {
  if (!detail.value) {
    return
  }
  const readings: EnvReadings = {}
  for (const field of readingFields) {
    readings[field.key] = detail.value.form[field.key]
  }
  const result = submitEnvCollection(Number(row.id), readings)
  flash(result)
  if (result.ok) {
    reload()
    refreshDetail()
  }
}

function confirmNormal(row: EntryRow) {
  const result = applyAction(meta.key, Number(row.id), '判定正常')
  flash(result)
  reload()
  refreshDetail()
}

function markOver(row: EntryRow) {
  const result = markEnvOver(Number(row.id))
  flash(result)
  reload()
  refreshDetail()
}

function reload() {
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    metrics.value = envSummary()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '廊内环境监测列表读取失败'
  }
}

onMounted(reload)
</script>
