import { create } from 'zustand'
import type { SearchMode } from './searchStore'

// Most-recent-first list of committed searches, persisted to localStorage so
// it survives restarts. Surfaced in the search dropdown when the field is
// empty so users can re-run a previous query.
const KEY = 'nova_search_history'
const MAX = 12

export type SearchHistoryItem = { query: string; mode: Exclude<SearchMode, null> }

function load(): SearchHistoryItem[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.slice(0, MAX) : []
  } catch {
    return []
  }
}

function persist(items: SearchHistoryItem[]) {
  try { localStorage.setItem(KEY, JSON.stringify(items)) } catch {}
}

type State = {
  items: SearchHistoryItem[]
  add: (item: SearchHistoryItem) => void
  remove: (item: SearchHistoryItem) => void
  clear: () => void
}

export const useSearchHistoryStore = create<State>((set) => ({
  items: load(),
  add: (item) => set((s) => {
    const query = item.query.trim()
    if (!query) return s
    // Dedup (move existing to front), cap at MAX.
    const next = [
      { query, mode: item.mode },
      ...s.items.filter((i) => !(i.query === query && i.mode === item.mode)),
    ].slice(0, MAX)
    persist(next)
    return { items: next }
  }),
  remove: (item) => set((s) => {
    const next = s.items.filter((i) => !(i.query === item.query && i.mode === item.mode))
    persist(next)
    return { items: next }
  }),
  clear: () => { persist([]); return set({ items: [] }) },
}))
