import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { FileEntry } from '../main/ipc/fs'
import type { TagColor } from '../main/ipc/tags'

export type SpecialPaths = {
  home: string
  desktop: string
  documents: string
  downloads: string
  pictures: string
  movies: string
  music: string
  applications: string
  volumes: string
  root: string
  icloud: string
}

// Streaming readdir: caller registers callbacks for the stat batches /
// completion event, gets back the lite entries via promise. Each call
// gets its own requestId so concurrent reads (left + right pane) don't
// trample each other.
let _nextReadStreamId = 1
const _readStatsListeners = new Map<number, (batch: { path: string; size: number; modified: number; created: number }[]) => void>()
const _readDoneListeners = new Map<number, () => void>()
ipcRenderer.on('fs:readdir:stats', (_e, requestId: number, batch: { path: string; size: number; modified: number; created: number }[]) => {
  _readStatsListeners.get(requestId)?.(batch)
})
ipcRenderer.on('fs:readdir:done', (_e, requestId: number) => {
  _readDoneListeners.get(requestId)?.()
  _readStatsListeners.delete(requestId)
  _readDoneListeners.delete(requestId)
})

contextBridge.exposeInMainWorld('fs', {
  readdir: (p: string, showHidden?: boolean) => ipcRenderer.invoke('fs:readdir', p, showHidden),
  readdirStream: (
    p: string,
    showHidden: boolean | undefined,
    onStats: (batch: { path: string; size: number; modified: number; created: number }[]) => void,
    onDone?: () => void,
  ) => {
    const requestId = _nextReadStreamId++
    _readStatsListeners.set(requestId, onStats)
    if (onDone) _readDoneListeners.set(requestId, onDone)
    const cleanup = () => {
      _readStatsListeners.delete(requestId)
      _readDoneListeners.delete(requestId)
    }
    return {
      promise: ipcRenderer.invoke('fs:readdir:stream', requestId, p, showHidden),
      cancel: cleanup,
    }
  },
  readdirsOnly: (p: string) => ipcRenderer.invoke('fs:readdirsOnly', p),
  stat: (p: string) => ipcRenderer.invoke('fs:stat', p),
  statBatch: (paths: string[]) => ipcRenderer.invoke('fs:statBatch', paths),
  readTextFile: (p: string) => ipcRenderer.invoke('fs:readTextFile', p),
  readBinaryFile: (p: string) => ipcRenderer.invoke('fs:readBinaryFile', p),
  rename: (src: string, dest: string) => ipcRenderer.invoke('fs:rename', src, dest),
  copy: (src: string, dest: string) => ipcRenderer.invoke('fs:copy', src, dest),
  delete: (p: string) => ipcRenderer.invoke('fs:delete', p),
  deletePermanent: (paths: string[]) => ipcRenderer.invoke('fs:deletePermanent', paths),
  confirmDelete: (count: number) => ipcRenderer.invoke('dialog:confirmDelete', count),
  permissions: (p: string) => ipcRenderer.invoke('fs:permissions', p),
  trashWithUndo: (paths: string[]) => ipcRenderer.invoke('fs:trashWithUndo', paths),
  move: (src: string, dest: string) => ipcRenderer.invoke('fs:move', src, dest),
  trashPath: () => ipcRenderer.invoke('fs:trashPath'),
  eject: (volumePath: string) => ipcRenderer.invoke('fs:eject', volumePath),
  emptyTrash: () => ipcRenderer.invoke('fs:emptyTrash'),
  mkdir: (p: string) => ipcRenderer.invoke('fs:mkdir', p),
  open: (p: string) => ipcRenderer.invoke('fs:open', p),
  homedir: () => ipcRenderer.invoke('fs:homedir'),
  diskUsage: (p: string) => ipcRenderer.invoke('fs:diskUsage', p),
  specialPaths: () => ipcRenderer.invoke('fs:specialPaths'),
  exists: (p: string) => ipcRenderer.invoke('fs:exists', p),
  showItemInFolder: (p: string) => ipcRenderer.invoke('fs:showItemInFolder', p),
  openPrivacySettings: () => ipcRenderer.invoke('shell:openPrivacySettings'),
  openAppleIdSettings: () => ipcRenderer.invoke('shell:openAppleIdSettings'),
  writeClipboardText: (text: string) => ipcRenderer.invoke('clipboard:writeText', text),
  writeClipboardFiles: (paths: string[]) => ipcRenderer.invoke('clipboard:writeFiles', paths),
  writeFile: (p: string, content?: string) => ipcRenderer.invoke('fs:writeFile', p, content),
  searchRecursive: (dir: string, query: string, mode: 'name' | 'content' | 'kind' | 'size') =>
    ipcRenderer.invoke('fs:searchRecursive', dir, query, mode),
  zip: (filePaths: string[]) => ipcRenderer.invoke('fs:zip', filePaths),
  unzip: (zipPath: string) => ipcRenderer.invoke('fs:unzip', zipPath),
  listZip: (zipPath: string) => ipcRenderer.invoke('fs:listZip', zipPath),
  folderSize: (p: string) => ipcRenderer.invoke('fs:folderSize', p),
  startDrag: (paths: string[]) => ipcRenderer.invoke('shell:startDrag', paths),
  // webUtils.getPathForFile is the canonical way to recover a real fs
  // path from a File object received via a native drop. Lives in the
  // renderer side of electron so it must be bridged through preload.
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  gitStatus: (dirPath: string) => ipcRenderer.invoke('fs:gitStatus', dirPath),
  openInTerminal: (dirPath: string, appName?: string) => ipcRenderer.invoke('shell:openInTerminal', dirPath, appName),
  listApps: () => ipcRenderer.invoke('apps:list'),
  openWith: (appPath: string, filePaths: string[]) => ipcRenderer.invoke('apps:openWith', appPath, filePaths),
  chooseAppAndOpen: (filePaths: string[]) => ipcRenderer.invoke('apps:chooseAndOpen', filePaths),
  watchStart: (p: string) => ipcRenderer.send('fs:watch:start', p),
  watchStop: (p: string) => ipcRenderer.send('fs:watch:stop', p),
  onWatchEvent: (cb: (e: { dirPath: string; eventType: string; filename: string }) => void) => {
    const handler = (_e: unknown, data: { dirPath: string; eventType: string; filename: string }) => cb(data)
    ipcRenderer.on('fs:watch:event', handler)
    return () => ipcRenderer.removeListener('fs:watch:event', handler)
  },
  onOpenSettings: (cb: () => void) => {
    ipcRenderer.on('app:open-settings', cb)
    return () => ipcRenderer.removeAllListeners('app:open-settings')
  },
  onCheckUpdate: (cb: () => void) => {
    ipcRenderer.on('app:check-update', cb)
    return () => ipcRenderer.removeAllListeners('app:check-update')
  },
  // Push the user's shortcut overrides to the main process so the native
  // menu-bar accelerators stay in sync with the in-app shortcuts.
  setMenuShortcuts: (overrides: Record<string, string>) => ipcRenderer.send('menu:setShortcuts', overrides),
  // Native menu item clicks dispatch a command id back to the renderer.
  onCommand: (cb: (id: string) => void) => {
    const handler = (_e: unknown, id: string) => cb(id)
    ipcRenderer.on('app:command', handler)
    return () => ipcRenderer.removeListener('app:command', handler)
  },
})

contextBridge.exposeInMainWorld('update', {
  onStatus: (cb: (payload: { status: string } & Record<string, unknown>) => void) => {
    ipcRenderer.on('update:status', (_e, payload) => cb(payload))
    return () => ipcRenderer.removeAllListeners('update:status')
  },
  install: () => ipcRenderer.send('update:install'),
  check: () => ipcRenderer.send('update:check'),
  isDownloaded: () => ipcRenderer.invoke('update:available'),
})

contextBridge.exposeInMainWorld('tags', {
  loadAll: () => ipcRenderer.invoke('tags:loadAll'),
  toggle: (p: string, color: TagColor) => ipcRenderer.invoke('tags:toggle', p, color),
  clear: (p: string) => ipcRenderer.invoke('tags:clear', p),
  rename: (oldP: string, newP: string) => ipcRenderer.invoke('tags:rename', oldP, newP),
})

declare global {
  interface Window {
    fs: {
      readdir(p: string, showHidden?: boolean): Promise<FileEntry[]>
      readdirStream(
        p: string,
        showHidden: boolean | undefined,
        onStats: (batch: { path: string; size: number; modified: number; created: number }[]) => void,
        onDone?: () => void,
      ): { promise: Promise<FileEntry[]>; cancel: () => void }
      readdirsOnly(p: string): Promise<FileEntry[]>
      stat(p: string): Promise<{ size: number; modified: number; created: number; isDirectory: boolean }>
      statBatch(paths: string[]): Promise<FileEntry[]>
      readTextFile(p: string): Promise<string | null>
      readBinaryFile(p: string): Promise<ArrayBuffer | null>
      rename(src: string, dest: string): Promise<void>
      copy(src: string, dest: string): Promise<void>
      delete(p: string): Promise<void>
      deletePermanent(paths: string[]): Promise<string[]>
      confirmDelete(count: number): Promise<boolean>
      permissions(p: string): Promise<{ octal: string; symbolic: string; owner: string; group: string }>
      trashWithUndo(paths: string[]): Promise<{ src: string; dst: string }[]>
      move(src: string, dest: string): Promise<void>
      trashPath(): Promise<string>
      eject(volumePath: string): Promise<void>
      emptyTrash(): Promise<void>
      mkdir(p: string): Promise<void>
      open(p: string): Promise<void>
      homedir(): Promise<string>
      diskUsage(p: string): Promise<{ total: number; free: number; used: number }>
      specialPaths(): Promise<SpecialPaths>
      exists(p: string): Promise<boolean>
      showItemInFolder(p: string): Promise<void>
      openPrivacySettings(): Promise<void>
      openAppleIdSettings(): Promise<void>
      writeClipboardText(text: string): Promise<void>
      writeClipboardFiles(paths: string[]): Promise<void>
      writeFile(p: string, content?: string): Promise<void>
      searchRecursive(dir: string, query: string, mode: 'name' | 'content' | 'kind' | 'size'): Promise<FileEntry[]>
      zip(filePaths: string[]): Promise<string>
      unzip(zipPath: string): Promise<void>
      listZip(zipPath: string): Promise<{ name: string; path: string; isDirectory: boolean; size: number; modified: number; ext: string }[]>
      folderSize(p: string): Promise<{ size: number; files: number; folders: number }>
      startDrag(paths: string[]): Promise<void>
      getPathForFile(file: File): string
      gitStatus(dirPath: string): Promise<Record<string, string>>
      openInTerminal(dirPath: string, appName?: string): Promise<void>
      listApps(): Promise<{ name: string; path: string }[]>
      openWith(appPath: string, filePaths: string[]): Promise<void>
      chooseAppAndOpen(filePaths: string[]): Promise<string | null>
      watchStart(p: string): void
      watchStop(p: string): void
      onWatchEvent(cb: (e: { dirPath: string; eventType: string; filename: string }) => void): () => void
      onOpenSettings(cb: () => void): () => void
      onCheckUpdate(cb: () => void): () => void
      setMenuShortcuts(overrides: Record<string, string>): void
      onCommand(cb: (id: string) => void): () => void
    }
    update: {
      onStatus(cb: (payload: { status: string } & Record<string, unknown>) => void): () => void
      install(): void
      check(): void
      isDownloaded(): Promise<boolean>
    }
    tags: {
      loadAll(): Promise<Record<string, TagColor[]>>
      toggle(p: string, color: TagColor): Promise<TagColor[]>
      clear(p: string): Promise<void>
      rename(oldP: string, newP: string): Promise<void>
    }
  }
}
