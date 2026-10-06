import { SEED_ROWS } from './seed'
import { migrateRows } from './migrations'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'urban-utility-tunnel:entries'
const META_KEY = 'urban-utility-tunnel:meta'
const DATA_VERSION = 2

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

type StoreMeta = { version: number }

function readMeta(): StoreMeta | null {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null
  }
  try {
    const raw = window.localStorage.getItem(META_KEY)
    return raw ? (JSON.parse(raw) as StoreMeta) : null
  } catch {
    return null
  }
}

// 整库一次性落库：要么整套写完，要么抛错由调用方回滚缓存，不许留半套中间态。
function persist(next: Record<string, EntryRow[]>): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  const snapshot = window.localStorage.getItem(STORAGE_KEY)
  const metaSnapshot = window.localStorage.getItem(META_KEY)
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    window.localStorage.setItem(META_KEY, JSON.stringify({ version: DATA_VERSION } satisfies StoreMeta))
  } catch (error) {
    // 落库失败：恢复到写入前的快照，字段没落库的一个都不许留在 localStorage 里。
    if (snapshot === null) {
      window.localStorage.removeItem(STORAGE_KEY)
    } else {
      window.localStorage.setItem(STORAGE_KEY, snapshot)
    }
    if (metaSnapshot === null) {
      window.localStorage.removeItem(META_KEY)
    } else {
      window.localStorage.setItem(META_KEY, metaSnapshot)
    }
    throw new Error(`数据落库失败，整套变更已退回：${error instanceof Error ? error.message : '存储不可用'}`)
  }
}

function seedStore(): Record<string, EntryRow[]> {
  return migrateRows(clone(SEED_ROWS), 1)
}

function readStorage(): Record<string, EntryRow[]> {
  if (typeof window === 'undefined' || !window.localStorage) {
    return seedStore()
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const fallback = seedStore()
    try {
      persist(fallback)
    } catch {
      // 存储不可用时退回内存态，不阻断页面。
    }
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    const fromVersion = readMeta()?.version ?? 1
    // 老版本数据（含早年把「未采集」写成「指标正常」的记录）在读取时按新口径回填。
    const merged = migrateRows({ ...clone(SEED_ROWS), ...parsed }, fromVersion)
    if (fromVersion < DATA_VERSION) {
      try {
        persist(merged)
      } catch {
        // 升级落库失败不丢内存结果，下次打开再尝试回填。
      }
    }
    return merged
  } catch {
    const fallback = seedStore()
    try {
      persist(fallback)
    } catch {
      // ignore
    }
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

// 单模块写入同样走整库事务：先落库再改缓存，落库失败时缓存保持原样。
export function saveRows(key: string, rows: EntryRow[]): void {
  const current = allRows()
  const next = { ...current, [key]: rows }
  persist(next)
  cache = next
}

// 跨模块一次性提交（如审批结论同时写作业申请与值班交接清单）：整套退回，不允许只成一半。
export function commitRows(next: Record<string, EntryRow[]>): void {
  const current = allRows()
  const full = { ...current, ...next }
  persist(full)
  cache = full
}

export function resetRows(key: string): EntryRow[] {
  const rows = migrateRows({ [key]: clone(SEED_ROWS[key] ?? []) }, DATA_VERSION)[key] ?? []
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
