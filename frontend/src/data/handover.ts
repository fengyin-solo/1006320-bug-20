import { ref } from 'vue'

import { appendNote, listNotes } from './local-store'

/**
 * 交接清单的唯一来源：环境监测页与运维值班交接页都读这里，
 * 保证「其它入口的交接清单」两处内容一致。
 */
export const handoverNotes = ref<string[]>([])

export function reloadHandoverNotes(): string[] {
  handoverNotes.value = [...listNotes()]
  return handoverNotes.value
}

/** 追加一条交接事项；落库失败会抛错，调用方按整笔退回提示。 */
export function addHandoverNote(note: string): void {
  appendNote(note)
  reloadHandoverNotes()
}

reloadHandoverNotes()
