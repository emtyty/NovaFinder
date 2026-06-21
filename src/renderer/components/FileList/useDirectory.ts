import { useEffect, useRef, useState } from 'react'

export type FileEntry = {
  name: string
  path: string
  isDirectory: boolean
  size: number
  modified: number
  created: number
  ext: string
}

// Streaming directory load:
//   1. Lite list (name + isDirectory + ext, size/modified = 0) returns
//      from the IPC roundtrip almost instantly even on 10k-entry dirs.
//      Names render immediately.
//   2. Stat batches stream in via 'fs:readdir:stats' events and merge
//      into existing entries by path. Size and Modified columns
//      backfill as batches arrive.
export function useDirectory(dirPath: string, showHidden: boolean) {
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const prevPath = useRef<string | null>(null)
  // Tracks the latest load so a fast directory switch doesn't get its
  // results clobbered by a late-arriving stat batch from the previous one.
  const loadTokenRef = useRef(0)

  async function load(p: string) {
    const token = ++loadTokenRef.current
    setLoading(true)
    setError(null)
    let handle: ReturnType<typeof window.fs.readdirStream> | undefined
    try {
      handle = window.fs.readdirStream(
        p,
        showHidden,
        (batch) => {
          if (loadTokenRef.current !== token) return
          setEntries((prev) => {
            // Merge stats by path. Build a map once per batch so we
            // don't pay an O(n*m) walk for big folders.
            const map = new Map(batch.map((b) => [b.path, b]))
            let changed = false
            const next = prev.map((e) => {
              const s = map.get(e.path)
              if (!s) return e
              if (e.size === s.size && e.modified === s.modified && e.created === s.created) return e
              changed = true
              return { ...e, size: s.size, modified: s.modified, created: s.created }
            })
            return changed ? next : prev
          })
        },
        () => {
          if (loadTokenRef.current === token) setLoading(false)
        },
      )
      const lite = await handle.promise
      if (loadTokenRef.current !== token) {
        handle.cancel()
        return
      }
      setEntries(lite as FileEntry[])
      // loading stays true until onDone fires — UI can show "still
      // loading details…" if it wants. For now most consumers will just
      // see names render immediately and not care about the flag.
    } catch (e) {
      if (loadTokenRef.current === token) {
        setError(String(e))
        setLoading(false)
      }
      handle?.cancel()
    }
  }

  useEffect(() => {
    if (!dirPath) return
    load(dirPath)
    window.fs.watchStart(dirPath)
    // Coalesce bursts of watcher events into a single reload. A bulk external
    // operation (cp of 1000 files, git checkout, npm install, …) fires many
    // fs events; without this each one triggered a full re-read. A short
    // trailing debounce collapses the storm into one reload after it settles.
    let debounce: ReturnType<typeof setTimeout> | null = null
    const off = window.fs.onWatchEvent((evt) => {
      if (evt.dirPath !== dirPath) return
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(() => { debounce = null; load(dirPath) }, 120)
    })
    return () => {
      if (debounce) clearTimeout(debounce)
      if (prevPath.current) window.fs.watchStop(prevPath.current)
      off()
    }
  }, [dirPath, showHidden])

  useEffect(() => { prevPath.current = dirPath }, [dirPath])

  return { entries, loading, error, reload: () => load(dirPath) }
}
