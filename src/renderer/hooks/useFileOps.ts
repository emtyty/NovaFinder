import path from 'path-browserify'
import { usePaneStore } from '../store/paneStore'
import { useClipboardStore } from '../store/clipboardStore'
import { useHistoryStore } from '../store/historyStore'
import { askConflict, type ConflictAction } from '../store/conflictStore'
import { useProgressStore } from '../store/progressStore'

export function useFileOps(onReload?: (removedPaths?: string[]) => void) {
  const { panes, activePaneId, setSelection } = usePaneStore()
  const { files: clipFiles, operation, setCut, setCopy, clear } = useClipboardStore()
  const pushHistory = useHistoryStore((s) => s.push)

  const activePane = panes[activePaneId]

  async function cut(paths: string[]) {
    setCut(paths)
    setSelection(activePaneId, paths)
  }

  async function copy(paths: string[]) {
    setCopy(paths)
    setSelection(activePaneId, paths)
    // Also place real file refs on the system clipboard so they can be pasted
    // into Finder and other apps, not just within NovaDirectory.
    window.fs.writeClipboardFiles(paths).catch(() => {})
  }

  // Build a name that doesn't collide: "file.txt" → "file 2.txt", "file 3.txt", etc.
  async function uniqueName(dir: string, name: string): Promise<string> {
    if (!(await window.fs.exists(path.join(dir, name)))) return name
    const ext = path.extname(name)
    const base = path.basename(name, ext)
    for (let n = 2; n < 1000; n++) {
      const candidate = `${base} ${n}${ext}`
      if (!(await window.fs.exists(path.join(dir, candidate)))) return candidate
    }
    return `${base}-${Date.now()}${ext}`
  }

  async function paste(destDir?: string) {
    const dest = destDir ?? activePane.path
    if (!clipFiles.length || !operation) return
    const movePairs: { src: string; dst: string }[] = []
    const copied: string[] = []
    // Remembered "apply to all" choice; once set, later conflicts skip the prompt.
    let bulkAction: ConflictAction | null = null

    const progress = useProgressStore.getState()
    const showProgress = clipFiles.length >= 2
    if (showProgress) progress.start(operation === 'cut' ? 'move' : 'copy', clipFiles.length)

    let processed = 0
    for (const src of clipFiles) {
      if (showProgress && useProgressStore.getState().isCancelled()) break
      const srcDir = path.dirname(src)
      const srcName = path.basename(src)
      if (showProgress) progress.update(processed, srcName)

      // Copy into the same folder = numbered duplicate, never a conflict.
      const sameDirCopy = operation === 'copy' && srcDir === dest
      let targetName = sameDirCopy ? await uniqueName(dest, srcName) : srcName
      let destPath = path.join(dest, targetName)
      // Pasting onto itself (e.g. cut+paste into the same folder) is a no-op.
      if (src === destPath) { processed++; continue }

      if (!sameDirCopy && await window.fs.exists(destPath)) {
        let action: ConflictAction | null = bulkAction
        if (!action) {
          const st = await window.fs.stat(destPath).catch(() => null)
          const res = await askConflict({
            name: srcName,
            destDir: dest,
            isDirectory: !!st?.isDirectory,
            remaining: clipFiles.length - processed - 1,
          })
          if (res.action === 'cancel') break
          action = res.action
          if (res.applyToAll) bulkAction = action
        }
        if (action === 'skip') { processed++; continue }
        if (action === 'keepboth') {
          targetName = await uniqueName(dest, srcName)
          destPath = path.join(dest, targetName)
        } else if (action === 'replace') {
          // Move the existing target to Trash so the new item replaces it
          // cleanly (rename onto a non-empty dir fails) and stays recoverable.
          try { await window.fs.delete(destPath) } catch { /* proceed anyway */ }
        }
      }

      try {
        if (operation === 'cut') {
          await window.fs.move(src, destPath)
          movePairs.push({ src, dst: destPath })
        } else {
          await window.fs.copy(src, destPath)
          copied.push(destPath)
        }
      } catch (e) {
        alert(`Failed to paste ${srcName}: ${e}`)
      }
      processed++
    }

    if (showProgress) { progress.update(processed, ''); progress.finish() }

    if (operation === 'cut') {
      clear()
      if (movePairs.length) pushHistory({ kind: 'move', pairs: movePairs })
    } else if (copied.length) {
      pushHistory({ kind: 'copy', created: copied })
    }
    onReload?.()
  }

  async function duplicate(paths: string[]) {
    const created: string[] = []
    const progress = useProgressStore.getState()
    const showProgress = paths.length >= 2
    if (showProgress) progress.start('copy', paths.length)

    let processed = 0
    for (const src of paths) {
      if (showProgress && useProgressStore.getState().isCancelled()) break
      const dir = path.dirname(src)
      const ext = path.extname(src)
      const base = path.basename(src, ext)
      if (showProgress) progress.update(processed, path.basename(src))
      const newName = await uniqueName(dir, `${base} copy${ext}`)
      try {
        const dest = path.join(dir, newName)
        await window.fs.copy(src, dest)
        created.push(dest)
      } catch (e) {
        alert(`Duplicate failed: ${e}`)
      }
      processed++
    }
    if (showProgress) { progress.update(processed, ''); progress.finish() }
    if (created.length) pushHistory({ kind: 'copy', created })
    onReload?.()
  }

  async function copyPath(paths: string[]) {
    await window.fs.writeClipboardText(paths.join('\n'))
  }

async function deleteFiles(paths: string[]) {
    let pairs: { src: string; dst: string }[] = []
    try {
      pairs = await window.fs.trashWithUndo(paths)
    } catch (e) {
      alert(`Delete failed: ${e}`)
    }
    if (pairs.length) pushHistory({ kind: 'trash', pairs })
    setSelection(activePaneId, [])
    onReload?.(pairs.map((p) => p.src))
  }

  // Permanent, irreversible delete (bypasses Trash, no undo). Confirms via a
  // native dialog first.
  async function deletePermanent(paths: string[]) {
    if (!paths.length) return
    const ok = await window.fs.confirmDelete(paths.length)
    if (!ok) return
    let failed: string[] = []
    try {
      failed = await window.fs.deletePermanent(paths)
    } catch (e) {
      alert(`Delete failed: ${e}`)
    }
    if (failed.length) alert(`Could not delete ${failed.length} item(s).`)
    setSelection(activePaneId, [])
    onReload?.(paths.filter((p) => !failed.includes(p)))
  }

  async function newFolder(parentDir: string, name: string) {
    const finalName = await uniqueName(parentDir, name)
    const full = path.join(parentDir, finalName)
    await window.fs.mkdir(full)
    pushHistory({ kind: 'create', path: full })
    onReload?.()
  }

  async function newFile(parentDir: string, name: string) {
    const finalName = await uniqueName(parentDir, name)
    const full = path.join(parentDir, finalName)
    await window.fs.writeFile(full, '')
    pushHistory({ kind: 'create', path: full })
    onReload?.()
  }

  async function rename(filePath: string, newName: string) {
    const dir = path.dirname(filePath)
    const dest = path.join(dir, newName)
    await window.fs.rename(filePath, dest)
    pushHistory({ kind: 'rename', from: filePath, to: dest })
    onReload?.()
  }

  return { cut, copy, paste, duplicate, copyPath, deleteFiles, deletePermanent, newFolder, newFile, rename }
}
