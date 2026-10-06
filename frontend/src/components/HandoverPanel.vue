<template>
  <section class="handover-panel">
    <header class="handover-head">
      <h3>跨入口交接清单</h3>
      <button class="btn ghost" type="button" @click="reload">刷新</button>
    </header>
    <p class="page-desc">
      本清单为廊内环境监测与运维值班交接共用的同一份记录：超标确认结论、重复上报差异、往期搬运与缺项情况都会写进这里。
    </p>
    <ul v-if="notes.length" class="handover-list">
      <li v-for="(note, index) in notes" :key="`${index}-${note}`">{{ note }}</li>
    </ul>
    <p v-else class="empty-state">暂无交接事项</p>
  </section>
</template>

<script setup lang="ts">
import { handoverNotes, reloadHandoverNotes } from '@/data/handover'

const notes = handoverNotes

function reload() {
  reloadHandoverNotes()
}
</script>
