import { SEED_ROWS } from './seed'
import { ENV_KEY, backfillEnvRows } from './env-rules'
import type { EntryRow } from './types'

// 本地持久化：业务数据与交接清单都放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'urban-utility-tunnel:entries'
const NOTE_KEY = 'urban-utility-tunnel:handover-notes'
const META_KEY = 'urban-utility-tunnel:meta'

const SCHEMA_VERSION = 2

export type StoredMeta = { version: number }
export type StoreShape = {
  entries: Record<string, EntryRow[]>
  notes: string[]
  meta: StoredMeta
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** 需要随版本升级做存量回填的模块：当前只有环境监测要把老记录按采集时间重算。 */
function migrateEntries(
  entries: Record<string, EntryRow[]>,
  version: number,
): Record<string, EntryRow[]> {
  if (version >= SCHEMA_VERSION) {
    return entries
  }
  return { ...entries, [ENV_KEY]: backfillEnvRows(entries[ENV_KEY] ?? []) }
}

type PersistInput = {
  entries: Record<string, EntryRow[]>
  notes: string[]
}

/**
 * 唯一落库口：先在内存里拼好整份快照，再一次性写 localStorage。
 * 写失败（配额/隐私模式等）时缓存保持原状并抛错，调用方按整笔退回处理——
 * 已改的字段不允许只落在内存或只落一半到存储里。
 */
function persist(input: PersistInput, previous: StoreShape): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      // 三个键必须一起写成功：任一失败都在 catch 里恢复提交前内容，杜绝半成品状态
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(input.entries))
      window.localStorage.setItem(NOTE_KEY, JSON.stringify(input.notes))
      window.localStorage.setItem(META_KEY, JSON.stringify({ version: SCHEMA_VERSION } satisfies StoredMeta))
    } catch (error) {
      // 落库失败：尽量把存储恢复成提交前的内容，杜绝中间态。
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(previous.entries))
        window.localStorage.setItem(NOTE_KEY, JSON.stringify(previous.notes))
        window.localStorage.setItem(META_KEY, JSON.stringify(previous.meta))
      } catch {
        // 存储本身已不可用，交给下面的抛错走整笔退回
      }
      throw error instanceof Error ? error : new Error('本地落库失败')
    }
  }
}

function readKey<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(key)
  if (!raw) {
    return fallback
  }
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function seedStore(): StoreShape {
  return {
    entries: clone(SEED_ROWS),
    notes: [],
    meta: { version: SCHEMA_VERSION },
  }
}

let cache: StoreShape | null = null

function loadStore(): StoreShape {
  if (cache !== null) {
    return cache
  }
  if (typeof window === 'undefined' || !window.localStorage) {
    cache = seedStore()
    return cache
  }
  const rawEntries = window.localStorage.getItem(STORAGE_KEY)
  if (!rawEntries) {
    const seeded = seedStore()
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded.entries))
      window.localStorage.setItem(NOTE_KEY, JSON.stringify(seeded.notes))
      window.localStorage.setItem(META_KEY, JSON.stringify(seeded.meta))
    } catch {
      // 首次播种都写不进时退回内存模式，至少不阻断页面
    }
    cache = seeded
    return cache
  }

  let parsedEntries: Record<string, EntryRow[]>
  try {
    parsedEntries = { ...clone(SEED_ROWS), ...(JSON.parse(rawEntries) as Record<string, EntryRow[]>) }
  } catch {
    const seeded = seedStore()
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded.entries))
    cache = seeded
    return cache
  }

  const meta = readKey<StoredMeta>(META_KEY, { version: 0 })
  const notes = readKey<string[]>(NOTE_KEY, [])
  const entries = migrateEntries(parsedEntries, meta.version)

  const store: StoreShape = { entries, notes, meta: { version: SCHEMA_VERSION } }
  try {
    persist({ entries, notes }, { entries: parsedEntries, notes, meta })
  } catch {
    // 存量回填落库失败不阻断读取：本次会话先用回填后的内存结果，等下次写操作再报退回
  }
  cache = store
  return cache
}

/**
 * 事务提交：mutator 只能改传入的草稿，返回值随成功结果带给调用方。
 * mutator 抛错或落库失败都不会动到当前缓存，保证「整套退回」。
 */
export function commit<T>(mutator: (draft: StoreShape) => T): { ok: true; value: T } | { ok: false; error: Error } {
  const current = loadStore()
  const draft: StoreShape = clone(current)
  let value: T
  try {
    value = mutator(draft)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error : new Error(String(error)) }
  }
  try {
    persist({ entries: draft.entries, notes: draft.notes }, current)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error : new Error('本地落库失败，已整套退回') }
  }
  cache = draft
  return { ok: true, value }
}

export function allRows(): Record<string, EntryRow[]> {
  return loadStore().entries
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function listNotes(): string[] {
  return loadStore().notes
}

export function appendNote(note: string): void {
  const result = commit((draft) => {
    draft.notes.push(note)
  })
  if (!result.ok) {
    throw result.error
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  const result = commit((draft) => {
    draft.entries[key] = rows
  })
  if (!result.ok) {
    throw result.error
  }
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
