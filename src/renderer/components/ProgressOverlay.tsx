import { useProgressStore } from '../store/progressStore'

const VERB: Record<string, string> = { copy: 'Copying', move: 'Moving', delete: 'Deleting' }

// Bottom-right toast with a determinate progress bar for bulk file operations.
// Appears only while an operation is active and shows a Cancel button that the
// running loop honors between items.
export function ProgressOverlay() {
  const { active, kind, total, done, currentName, cancelled, cancel } = useProgressStore()
  if (!active) return null

  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0
  const verb = VERB[kind] ?? 'Working'

  return (
    <div className="fixed bottom-4 right-4 z-[9997] w-[300px] rounded-lg border border-[var(--border-color)] bg-[var(--bg)] shadow-2xl overflow-hidden">
      <div className="px-3 py-2.5 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[12px] font-semibold text-[var(--text)]">
            {cancelled ? 'Finishing…' : verb}
          </span>
          <span className="text-[11px] text-[var(--text-muted)] tabular-nums">
            {done} / {total}
          </span>
        </div>
        <div className="h-1.5 rounded-full bg-[var(--hover-bg)] overflow-hidden">
          <div
            className="h-full bg-[var(--accent-color)] transition-[width] duration-150"
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-[var(--text-muted)] truncate min-w-0" title={currentName}>
            {currentName}
          </span>
          {!cancelled && (
            <button
              onClick={cancel}
              className="flex-shrink-0 text-[11px] text-[var(--text-muted)] hover:text-[var(--text)] underline"
            >
              Cancel
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
