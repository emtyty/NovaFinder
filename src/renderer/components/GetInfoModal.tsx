import { useEffect, useState } from 'react'
import path from 'path-browserify'
import { formatSize, formatDate } from '../lib/formatters'
import { FileIcon } from './FileIcon'

type Props = {
  filePath: string
  onClose: () => void
}

type FolderSize = { size: number; files: number; folders: number }
type Permissions = { octal: string; symbolic: string; owner: string; group: string }

export function GetInfoModal({ filePath, onClose }: Props) {
  const [info, setInfo] = useState<{
    size: number
    modified: number
    created: number
    isDirectory: boolean
    childCount?: number
  } | null>(null)
  // Folder size is computed only on demand because the walk can be slow
  // on big trees. null = idle, 'loading' = in progress, FolderSize = done.
  const [folderSize, setFolderSize] = useState<FolderSize | 'loading' | null>(null)
  const [perms, setPerms] = useState<Permissions | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      const stat = await window.fs.stat(filePath)
      let childCount: number | undefined
      if (stat.isDirectory) {
        try {
          const entries = await window.fs.readdir(filePath, true)
          childCount = entries.length
        } catch {}
      }
      if (cancelled) return
      setInfo({ ...stat, childCount })
      window.fs.permissions(filePath)
        .then((p) => { if (!cancelled) setPerms(p) })
        .catch(() => {})
      // Auto-calculate folder size in the background. Walk runs in the
      // main process so the UI stays responsive; if it returns fast the
      // user never sees the "Calculating…" placeholder.
      if (stat.isDirectory) {
        setFolderSize('loading')
        try {
          const r = await window.fs.folderSize(filePath)
          if (!cancelled) setFolderSize(r)
        } catch {
          if (!cancelled) setFolderSize(null)
        }
      }
    }
    load()
    return () => { cancelled = true }
  }, [filePath])

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const name = path.basename(filePath)
  const ext = path.extname(filePath).toLowerCase().slice(1)
  const sizeLine = info && (info.isDirectory
    ? (folderSize && folderSize !== 'loading'
        ? `${formatSize(folderSize.size)} · ${folderSize.files.toLocaleString()} files, ${folderSize.folders.toLocaleString()} folders`
        : (info.childCount !== undefined ? `${info.childCount} items` : 'Folder'))
    : formatSize(info.size))

  return (
    <div
      className="fixed inset-0 bg-black/30 flex items-center justify-center z-[9998]"
      onClick={onClose}
    >
      <div
        className="bg-[var(--bg)] border border-[var(--border-color)] rounded-lg shadow-2xl w-[360px] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-4 border-b border-[var(--border-color)]">
          <div className="w-12 h-12 flex items-center justify-center flex-shrink-0">
            <FileIcon ext={ext} isDirectory={!!info?.isDirectory} size={44} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[13px] font-semibold text-[var(--text)] truncate">{name}</div>
            {info && (
              <div className="text-[11px] text-[var(--text-muted)]">{sizeLine}</div>
            )}
          </div>
        </div>

        <div className="px-4 py-3 text-[12px] text-[var(--text)] space-y-1.5">
          <Row label="Kind" value={info?.isDirectory ? 'Folder' : (ext ? `${ext.toUpperCase()} document` : 'Document')} />
          {info && !info.isDirectory && <Row label="Size" value={formatSize(info.size)} />}
          {info?.isDirectory && (
            <Row label="Size">
              {folderSize && folderSize !== 'loading' ? (
                <span>{formatSize(folderSize.size)}</span>
              ) : (
                <span className="text-[var(--text-muted)]">Calculating…</span>
              )}
            </Row>
          )}
          {info?.isDirectory && folderSize && folderSize !== 'loading' && (
            <Row label="Contains" value={`${folderSize.files.toLocaleString()} files, ${folderSize.folders.toLocaleString()} folders`} />
          )}
          <Row label="Where" value={path.dirname(filePath)} mono />
          {info && <Row label="Created" value={formatDate(info.created)} />}
          {info && <Row label="Modified" value={formatDate(info.modified)} />}
          {perms && <Row label="Owner" value={`${perms.owner} : ${perms.group}`} />}
          {perms && <Row label="Permissions" value={`${perms.symbolic}  (${perms.octal})`} mono />}
        </div>

        <div className="flex justify-end px-4 py-3 border-t border-[var(--border-color)] bg-[var(--header-bg)]">
          <button
            onClick={onClose}
            className="px-4 py-1 rounded-md bg-[var(--accent-color)] text-white text-[12px] hover:brightness-110"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

function Row({ label, value, mono, children }: { label: string; value?: string; mono?: boolean; children?: React.ReactNode }) {
  return (
    <div className="flex gap-2 items-baseline">
      <div className="w-20 text-right text-[var(--text-muted)] flex-shrink-0">{label}:</div>
      <div className={`flex-1 break-all ${mono ? 'font-mono text-[11px]' : ''}`}>
        {children ?? value}
      </div>
    </div>
  )
}
