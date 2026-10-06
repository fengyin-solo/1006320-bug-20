<template>
  <section class="page" data-module="entryapprove">
    <header class="page-head">
      <div>
        <h2>入廊作业审批管理</h2>
        <p class="page-desc">审批结论与运维值班交接清单写同一份：批准、驳回、完工确认时两边同步更新，内容保持一致。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记作业申请</button>
        <button class="btn" type="button" @click="exportRows">导出入廊作业审批清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">待审批申请</span>
        <strong class="stat-value">{{ stats.pending }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">已批准申请</span>
        <strong class="stat-value">{{ stats.approved }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">已驳回申请</span>
        <strong class="stat-value">{{ stats.rejected }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">已完工</span>
        <strong class="stat-value">{{ stats.done }}</strong>
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
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] === '' || row[column] === undefined ? '—' : row[column] }}</td>
          <td>{{ row.status }}</td>
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
          <td :colspan="columns.length + 2" class="empty-state">暂无入廊作业审批数据，可先登记作业申请</td>
        </tr>
      </tbody>
    </table>

    <section class="handover-box">
      <header class="handover-head">
        <h3>写入值班交接清单的审批结论（与「运维值班交接」页同一份）</h3>
        <button class="btn ghost" type="button" @click="loadHandover">刷新</button>
      </header>
      <ul v-if="handoverLines.length" class="handover-list">
        <li v-for="line in handoverLines" :key="`${line.applyId}-${line.time}`">
          <span class="handover-time">{{ line.time }}</span>
          {{ line.text }}
        </li>
      </ul>
      <p v-else class="empty-state">暂无已同步的审批结论，批准/驳回/完工后会自动写入。</p>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条入廊作业审批记录</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  handoverEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow, HandoverLine } from '@/data/types'

const meta = moduleMeta('entryapprove')
const columns = ['申请编号', '申请单位', '作业舱室', '作业类型', '作业人数', '安全措施', '审批人员', '审批结论', '审批状态']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const infoMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ['申请编号', '申请单位', '作业舱室']
const handoverLines = ref<HandoverLine[]>([])

const stats = computed(() => ({
  pending: rows.value.filter((row) => row.status === '待审批').length,
  approved: rows.value.filter((row) => row.status === '已批准').length,
  rejected: rows.value.filter((row) => row.status === '已驳回').length,
  done: rows.value.filter((row) => row.status === '已完工').length,
}))

const statusSummary = computed(() =>
  ['待审批', '已批准', '已驳回', '已完工'].map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function actionsFor(row: EntryRow): string[] {
  switch (String(row.status)) {
    case '待审批':
      return ['批准申请', '驳回申请']
    case '已批准':
      return ['完工确认', '驳回申请']
    default:
      return []
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
  errorMessage.value = '作业申请登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (result.ok) {
    infoMessage.value = result.message
  } else {
    errorMessage.value = result.message
  }
  reload()
  loadHandover()
}

function loadHandover() {
  handoverLines.value = handoverEntries()
}

function reload() {
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '入廊作业审批列表读取失败'
  }
}

onMounted(() => {
  reload()
  loadHandover()
})
</script>
