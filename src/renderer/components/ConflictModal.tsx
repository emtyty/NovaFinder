import { useEffect, useState } from 'react'
import { useConflictStore, type ConflictAction } from '../store/conflictStore'

// Finder-style "an item named X already exists" prompt shown during paste/move
// when the destination already has a file/folder of the same name.
export function ConflictModal() {
  const current = useConflictStore((s) => s.current)
  const close = useConflictStore((s) => s.close)
  const [applyToAll, setApplyToAll] = useState(false)

  // Reset the checkbox for each fresh conflict.
  useEffect(() => { setApplyToAll(false) }, [current?.name, current?.destDir])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!current) return
      if (e.key === 'Escape') { e.preventDefault(); close({ action: 'cancel', applyToAll: false }) }
      if (e.key === 'Enter') { e.preventDefault(); close({ action: 'replace', applyToAll }) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [current, applyToAll, close])

  if (!current) return null
  const kind = current.isDirectory ? 'folder' : 'file'
  const resolve = (action: ConflictAction) => close({ action, applyToAll })

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-[9999]">
      <div className="bg-[var(--bg)] border border-[var(--border-color)] rounded-lg shadow-2xl w-[420px] overflow-hidden">
        <div className="px-5 py-4 space-y-2">
          <div className="text-[13px] font-semibold text-[var(--text)]">
            An item named “{current.name}” already exists in this location.
          </div>
          <div className="text-[12px] text-[var(--text-muted)]">
            Do you want to replace the existing {kind}, keep both, or skip it?
          </div>
          {current.remaining > 0 && (
            <label className="flex items-center gap-2 text-[12px] text-[var(--text)] pt-1 select-none cursor-pointer">
              <input
                type="checkbox"
                checked={applyToAll}
                onChange={(e) => setApplyToAll(e.target.checked)}
              />
              Apply to all {current.remaining + 1} remaining items
            </label>
          )}
        </div>
        <div className="flex justify-between items-center gap-2 px-5 py-3 border-t border-[var(--border-color)] bg-[var(--header-bg)]">
          <button
            onClick={() => close({ action: 'cancel', applyToAll: false })}
            className="px-3 py-1 rounded-md text-[12px] text-[var(--text-muted)] hover:text-[var(--text)]"
          >
            Cancel
          </button>
          <div className="flex gap-2">
            <button
              onClick={() => resolve('skip')}
              className="px-3 py-1 rounded-md border border-[var(--border-color)] text-[12px] text-[var(--text)] hover:bg-[var(--hover-bg)]"
            >
              Skip
            </button>
            <button
              onClick={() => resolve('keepboth')}
              className="px-3 py-1 rounded-md border border-[var(--border-color)] text-[12px] text-[var(--text)] hover:bg-[var(--hover-bg)]"
            >
              Keep Both
            </button>
            <button
              onClick={() => resolve('replace')}
              className="px-3 py-1 rounded-md bg-[var(--accent-color)] text-white text-[12px] hover:brightness-110"
            >
              Replace
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
