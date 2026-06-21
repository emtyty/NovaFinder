import { create } from 'zustand'

// Drives the progress overlay for long-running, item-by-item operations
// (paste/copy/move, duplicate, permanent delete). Progress is tracked at the
// item level — "12 of 340" — which is enough to make bulk operations feel
// non-silent without per-byte streaming from the main process.
export type ProgressKind = 'copy' | 'move' | 'delete'

type State = {
  active: boolean
  kind: ProgressKind
  total: number
  done: number
  currentName: string
  // Set true when the user clicks Cancel; the running loop checks this
  // between items and stops cleanly. It cannot interrupt a single in-flight
  // item (e.g. one huge file mid-copy).
  cancelled: boolean
  start: (kind: ProgressKind, total: number) => void
  update: (done: number, currentName: string) => void
  finish: () => void
  cancel: () => void
  isCancelled: () => boolean
}

export const useProgressStore = create<State>((set, get) => ({
  active: false,
  kind: 'copy',
  total: 0,
  done: 0,
  currentName: '',
  cancelled: false,
  start: (kind, total) => set({ active: true, kind, total, done: 0, currentName: '', cancelled: false }),
  update: (done, currentName) => set({ done, currentName }),
  finish: () => set({ active: false, currentName: '' }),
  cancel: () => set({ cancelled: true }),
  isCancelled: () => get().cancelled,
}))
