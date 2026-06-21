import { create } from 'zustand'

// A name collision encountered during paste/move. The UI presents Replace /
// Keep Both / Skip, optionally "apply to all remaining", mirroring Finder.
export type ConflictAction = 'replace' | 'keepboth' | 'skip'
export type ConflictResult = { action: ConflictAction | 'cancel'; applyToAll: boolean }

export type ConflictRequest = {
  name: string
  destDir: string
  isDirectory: boolean
  // How many more items still need to be processed — drives whether the
  // "Apply to all" checkbox is worth showing.
  remaining: number
  resolve: (r: ConflictResult) => void
}

type State = {
  current: ConflictRequest | null
  show: (opts: Omit<ConflictRequest, 'resolve'>) => Promise<ConflictResult>
  close: (r: ConflictResult) => void
}

export const useConflictStore = create<State>((set, get) => ({
  current: null,
  show: (opts) => new Promise((resolve) => set({ current: { ...opts, resolve } })),
  close: (r) => {
    const cur = get().current
    if (cur) cur.resolve(r)
    set({ current: null })
  },
}))

export const askConflict = (opts: Omit<ConflictRequest, 'resolve'>) =>
  useConflictStore.getState().show(opts)
