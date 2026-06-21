import { ipcMain, webContents, type WebContents } from 'electron'
import fsSync from 'fs'

// One FSWatcher per watched directory, shared across every subscriber. A
// subscriber is a (webContents, dirPath) pair — so the left pane, the right
// pane, a second tab, and a second window can all watch the same folder
// without each spinning up its own watcher, and one of them navigating away
// (watch:stop) doesn't kill live updates for the others.
type Entry = {
  watcher: fsSync.FSWatcher
  // webContents.id -> subscription count. A single webContents can subscribe
  // more than once (two panes on the same dir), so we count rather than store
  // a boolean.
  refs: Map<number, number>
}

const entries = new Map<string, Entry>()
const cleanupAttached = new WeakSet<WebContents>()

function broadcast(dirPath: string, eventType: string, filename: string | null) {
  const entry = entries.get(dirPath)
  if (!entry) return
  for (const id of entry.refs.keys()) {
    const wc = webContents.fromId(id)
    if (wc && !wc.isDestroyed()) {
      wc.send('fs:watch:event', { dirPath, eventType, filename })
    }
  }
}

function closeIfUnused(dirPath: string, entry: Entry) {
  if (entry.refs.size === 0) {
    entry.watcher.close()
    entries.delete(dirPath)
  }
}

function release(dirPath: string, wcId: number, all = false) {
  const entry = entries.get(dirPath)
  if (!entry) return
  const count = entry.refs.get(wcId)
  if (count === undefined) return
  if (all || count <= 1) entry.refs.delete(wcId)
  else entry.refs.set(wcId, count - 1)
  closeIfUnused(dirPath, entry)
}

// Drop every subscription a webContents holds when its window goes away
// without matching watch:stop calls (e.g. the window is closed while still
// viewing a folder). Without this the FSWatcher would leak.
function attachCleanup(wc: WebContents) {
  if (cleanupAttached.has(wc)) return
  cleanupAttached.add(wc)
  const id = wc.id
  wc.once('destroyed', () => {
    for (const dirPath of [...entries.keys()]) release(dirPath, id, true)
  })
}

let registered = false

// Registered ONCE for the whole app (not per-window): ipcMain handlers are
// process-global, so registering per BrowserWindow would attach duplicate
// listeners. Events are routed back via e.sender / refcounted webContents ids
// rather than a captured window, so every window gets its own updates.
export function registerWatcherHandlers() {
  if (registered) return
  registered = true

  ipcMain.on('fs:watch:start', (e, dirPath: string) => {
    const wcId = e.sender.id
    let entry = entries.get(dirPath)
    if (!entry) {
      let watcher: fsSync.FSWatcher
      try {
        // recursive:true so changes inside nested subfolders also notify, not
        // just the directory's direct children. On macOS this is backed by
        // FSEvents so it stays cheap even on large trees; the renderer
        // debounces reloads, so a burst of nested events collapses into one.
        watcher = fsSync.watch(dirPath, { persistent: false, recursive: true }, (eventType, filename) => {
          broadcast(dirPath, eventType, typeof filename === 'string' ? filename : null)
        })
      } catch {
        // directory may not exist or be inaccessible
        return
      }
      entry = { watcher, refs: new Map() }
      entries.set(dirPath, entry)
    }
    entry.refs.set(wcId, (entry.refs.get(wcId) ?? 0) + 1)
    attachCleanup(e.sender)
  })

  ipcMain.on('fs:watch:stop', (e, dirPath: string) => {
    release(dirPath, e.sender.id)
  })
}

export function stopAllWatchers() {
  for (const entry of entries.values()) entry.watcher.close()
  entries.clear()
}
