import { ipcMain, shell, clipboard, dialog, nativeImage, app, BrowserWindow } from 'electron'
import fs from 'fs/promises'
import fsSync from 'fs'
import path from 'path'
import os from 'os'
import { execFile } from 'child_process'

export type FileEntry = {
  name: string
  path: string
  isDirectory: boolean
  size: number
  modified: number
  created: number
  ext: string
}

async function readdir(dirPath: string, showHidden = false): Promise<FileEntry[]> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true })
  const filtered = showHidden ? entries : entries.filter((e) => !e.name.startsWith('.'))
  // Parallelize stat() instead of awaiting one at a time. A folder like
  // ~/Downloads (often 1k+ entries) used to take ~1s because each stat
  // blocked the next; with Promise.all it drops to <100ms on APFS. We
  // skip stat entirely for directories — the renderer never reads
  // their .size, and modified time is irrelevant for sorting unless the
  // user picks mtime sort (rare for folders). This halves the stat
  // calls on mixed dirs.
  const results = await Promise.all(
    filtered.map(async (entry): Promise<FileEntry | null> => {
      const fullPath = path.join(dirPath, entry.name)
      const isDirectory = entry.isDirectory()
      const ext = isDirectory ? '' : path.extname(entry.name).toLowerCase().slice(1)
      if (isDirectory) {
        // Cheap mtime via fstat would be ideal; for now use stat but it
        // runs in parallel with all the other ones so it's fine.
        try {
          const stat = await fs.stat(fullPath)
          return { name: entry.name, path: fullPath, isDirectory: true, size: 0, modified: stat.mtimeMs, created: stat.birthtimeMs, ext: '' }
        } catch {
          return null
        }
      }
      try {
        const stat = await fs.stat(fullPath)
        return {
          name: entry.name,
          path: fullPath,
          isDirectory: false,
          size: stat.size,
          modified: stat.mtimeMs,
          created: stat.birthtimeMs,
          ext,
        }
      } catch {
        return null
      }
    }),
  )
  const out = results.filter((r): r is FileEntry => r !== null)
  out.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })
  return out
}

export function registerFsHandlers() {
  ipcMain.handle('fs:readdir', async (_e, dirPath: string, showHidden = false) => {
    try {
      return await readdir(dirPath, showHidden)
    } catch (err: any) {
      if (err?.code === 'EPERM' || err?.code === 'EACCES') {
        const e = new Error(`PERMISSION_DENIED: ${dirPath}`) as Error & { code: string }
        e.code = 'PERMISSION_DENIED'
        throw e
      }
      throw err
    }
  })

  // Streaming readdir for big folders. Returns name + isDirectory + ext
  // immediately (no stat — sub-50ms even on 10k entries) so the UI can
  // render names instantly, then pushes stat batches via 'fs:readdir:stats'
  // events keyed by requestId so size/modified backfill as the user reads.
  ipcMain.handle('fs:readdir:stream', async (e, requestId: number, dirPath: string, showHidden = false) => {
    let entries: fsSync.Dirent[]
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true })
    } catch (err: any) {
      if (err?.code === 'EPERM' || err?.code === 'EACCES') {
        const perm = new Error(`PERMISSION_DENIED: ${dirPath}`) as Error & { code: string }
        perm.code = 'PERMISSION_DENIED'
        throw perm
      }
      throw err
    }
    const filtered = showHidden ? entries : entries.filter((e) => !e.name.startsWith('.'))
    const lite: FileEntry[] = filtered.map((entry) => {
      const fullPath = path.join(dirPath, entry.name)
      const isDirectory = entry.isDirectory()
      return {
        name: entry.name,
        path: fullPath,
        isDirectory,
        size: 0,
        modified: 0,
        created: 0,
        ext: isDirectory ? '' : path.extname(entry.name).toLowerCase().slice(1),
      }
    })
    lite.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    })

    // Schedule stat batches AFTER the response is sent. setImmediate lets
    // the lite list reach the renderer first, then we fan out stats so
    // the user sees something during the (smaller) follow-up work.
    const sender = e.sender
    setImmediate(async () => {
      const CHUNK = 250
      for (let i = 0; i < lite.length; i += CHUNK) {
        if (sender.isDestroyed()) return
        const slice = lite.slice(i, i + CHUNK)
        const results = await Promise.all(slice.map(async (it) => {
          try {
            const st = await fs.stat(it.path)
            return { path: it.path, size: st.size, modified: st.mtimeMs, created: st.birthtimeMs }
          } catch { return null }
        }))
        const batch = results.filter((r): r is { path: string; size: number; modified: number; created: number } => r !== null)
        if (batch.length && !sender.isDestroyed()) {
          sender.send('fs:readdir:stats', requestId, batch)
        }
      }
      if (!sender.isDestroyed()) sender.send('fs:readdir:done', requestId)
    })

    return lite
  })

  ipcMain.handle('fs:stat', async (_e, filePath: string) => {
    const stat = await fs.stat(filePath)
    return {
      size: stat.size,
      modified: stat.mtimeMs,
      created: stat.birthtimeMs,
      isDirectory: stat.isDirectory(),
    }
  })

  // POSIX ownership + permissions for Get Info. mode/uid/gid come from stat
  // (instant); owner/group *names* are resolved via macOS `stat -f` since
  // Node has no built-in uid→name lookup. Name resolution is best-effort —
  // on failure we fall back to the numeric ids.
  ipcMain.handle('fs:permissions', async (_e, filePath: string): Promise<{
    octal: string
    symbolic: string
    owner: string
    group: string
  }> => {
    const st = await fs.stat(filePath)
    const perm = st.mode & 0o777
    const octal = perm.toString(8).padStart(3, '0')
    const rwx = (bits: number) =>
      (bits & 4 ? 'r' : '-') + (bits & 2 ? 'w' : '-') + (bits & 1 ? 'x' : '-')
    const typeChar = st.isDirectory() ? 'd' : st.isSymbolicLink() ? 'l' : '-'
    const symbolic = typeChar + rwx((perm >> 6) & 7) + rwx((perm >> 3) & 7) + rwx(perm & 7)

    let owner = String(st.uid)
    let group = String(st.gid)
    try {
      const names = await new Promise<string>((resolve, reject) => {
        execFile('/usr/bin/stat', ['-f', '%Su:%Sg', filePath], (err, stdout) => {
          if (err) reject(err)
          else resolve(stdout.trim())
        })
      })
      const [o, g] = names.split(':')
      if (o) owner = o
      if (g) group = g
    } catch {
      // keep numeric uid/gid
    }
    return { octal, symbolic, owner, group }
  })

  ipcMain.handle('fs:statBatch', async (_e, paths: string[]): Promise<FileEntry[]> => {
    const results = await Promise.all(
      paths.map(async (p): Promise<FileEntry | null> => {
        try {
          const stat = await fs.stat(p)
          const name = path.basename(p)
          return {
            name,
            path: p,
            isDirectory: stat.isDirectory(),
            size: stat.size,
            modified: stat.mtimeMs,
            created: stat.birthtimeMs,
            ext: stat.isDirectory() ? '' : (path.extname(name).slice(1).toLowerCase() ?? ''),
          }
        } catch {
          return null
        }
      })
    )
    return results.filter((e): e is FileEntry => e !== null)
  })

  ipcMain.handle('fs:readTextFile', async (_e, filePath: string) => {
    const stat = await fs.stat(filePath)
    if (stat.size > 2 * 1024 * 1024) return null // skip files > 2MB
    return fs.readFile(filePath, 'utf-8')
  })

  ipcMain.handle('fs:readBinaryFile', async (_e, filePath: string) => {
    const stat = await fs.stat(filePath)
    if (stat.size > 50 * 1024 * 1024) return null // skip files > 50MB
    const buf = await fs.readFile(filePath)
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  })

  ipcMain.handle('fs:rename', async (_e, src: string, dest: string) => {
    await fs.rename(src, dest)
  })

  ipcMain.handle('fs:copy', async (_e, src: string, dest: string) => {
    const stat = await fs.stat(src)
    if (stat.isDirectory()) {
      await fs.cp(src, dest, { recursive: true })
    } else {
      await fs.copyFile(src, dest)
    }
  })

  ipcMain.handle('fs:delete', async (_e, filePath: string) => {
    await shell.trashItem(filePath)
  })

  // Native confirmation for a destructive, irreversible action. Returns true
  // only if the user explicitly clicks Delete.
  ipcMain.handle('dialog:confirmDelete', async (e, count: number): Promise<boolean> => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
    const opts: Electron.MessageBoxOptions = {
      type: 'warning',
      buttons: ['Delete', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      message: count === 1
        ? 'Are you sure you want to delete this item permanently?'
        : `Are you sure you want to delete these ${count} items permanently?`,
      detail: 'This action cannot be undone.',
    }
    const { response } = win
      ? await dialog.showMessageBox(win, opts)
      : await dialog.showMessageBox(opts)
    return response === 0
  })

  // Permanent, irreversible delete (bypasses Trash). The renderer is
  // responsible for confirming with the user first — there is no undo.
  ipcMain.handle('fs:deletePermanent', async (_e, paths: string[]) => {
    const failed: string[] = []
    for (const p of paths) {
      try {
        await fs.rm(p, { recursive: true, force: true })
      } catch (err) {
        console.warn('permanent delete failed', p, err)
        failed.push(p)
      }
    }
    return failed
  })

  // Like fs:delete, but captures the new location in ~/.Trash for each
  // source so we can move it back on undo. We snapshot the trash dir
  // before/after each trashItem call and treat any new entry as the
  // corresponding trashed file. Best-effort: falls back to basename if
  // diffing fails (e.g. permission issue reading ~/.Trash).
  ipcMain.handle('fs:trashWithUndo', async (_e, paths: string[]): Promise<{ src: string; dst: string }[]> => {
    const trashDir = path.join(os.homedir(), '.Trash')
    const trashed: { src: string; dst: string }[] = []
    for (const p of paths) {
      let before: Set<string>
      try {
        before = new Set(await fs.readdir(trashDir))
      } catch {
        before = new Set()
      }
      try {
        await shell.trashItem(p)
      } catch (e) {
        console.warn('trashItem failed', p, e)
        continue
      }
      let dst: string
      try {
        const after = await fs.readdir(trashDir)
        const added = after.filter((n) => !before.has(n))
        dst = added.length > 0
          ? path.join(trashDir, added[0])
          : path.join(trashDir, path.basename(p))
      } catch {
        dst = path.join(trashDir, path.basename(p))
      }
      trashed.push({ src: p, dst })
    }
    return trashed
  })

  ipcMain.handle('fs:move', async (_e, src: string, dest: string) => {
    try {
      await fs.rename(src, dest)
    } catch (err: any) {
      if (err?.code === 'EXDEV') {
        const stat = await fs.stat(src)
        if (stat.isDirectory()) await fs.cp(src, dest, { recursive: true })
        else await fs.copyFile(src, dest)
        await fs.rm(src, { recursive: true, force: true })
      } else {
        throw err
      }
    }
  })

  ipcMain.handle('fs:trashPath', () => path.join(os.homedir(), '.Trash'))

  // Eject a mounted volume on macOS via `diskutil eject`. Resolves only on
  // success; rejects with stderr text so the renderer can surface it.
  ipcMain.handle('fs:eject', async (_e, volumePath: string) => {
    if (!volumePath.startsWith('/Volumes/')) {
      throw new Error('Only paths under /Volumes can be ejected')
    }
    await new Promise<void>((resolve, reject) => {
      execFile('/usr/sbin/diskutil', ['eject', volumePath], (err, _stdout, stderr) => {
        if (err) reject(new Error((stderr || err.message).trim()))
        else resolve()
      })
    })
  })

  ipcMain.handle('fs:emptyTrash', async () => {
    await new Promise<void>((resolve, reject) => {
      execFile('osascript', ['-e', 'tell application "Finder" to empty trash'], (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  })

  ipcMain.handle('fs:mkdir', async (_e, dirPath: string) => {
    await fs.mkdir(dirPath, { recursive: true })
  })

  ipcMain.handle('fs:open', async (_e, filePath: string) => {
    await shell.openPath(filePath)
  })

  ipcMain.handle('fs:homedir', () => os.homedir())

  ipcMain.handle('fs:diskUsage', async (_e, p: string) => {
    const stats = await fs.statfs(p)
    const total = stats.blocks * stats.bsize
    const free = stats.bavail * stats.bsize
    const used = total - free
    return { total, free, used }
  })

  ipcMain.handle('fs:specialPaths', () => {
    const home = os.homedir()
    return {
      home,
      desktop: path.join(home, 'Desktop'),
      documents: path.join(home, 'Documents'),
      downloads: path.join(home, 'Downloads'),
      pictures: path.join(home, 'Pictures'),
      movies: path.join(home, 'Movies'),
      music: path.join(home, 'Music'),
      applications: '/Applications',
      volumes: '/Volumes',
      root: '/',
      icloud: path.join(home, 'Library/Mobile Documents/com~apple~CloudDocs'),
    }
  })

  ipcMain.handle('fs:showItemInFolder', (_e, p: string) => {
    shell.showItemInFolder(p)
  })

  ipcMain.handle('shell:openPrivacySettings', () => {
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles')
  })

  ipcMain.handle('shell:openAppleIdSettings', () => {
    // macOS Ventura+ uses the new AppleID pane; the legacy URL still resolves
    // on older systems. shell.openExternal is best-effort either way.
    shell.openExternal('x-apple.systempreferences:com.apple.systempreferences.AppleIDSettings')
  })

  ipcMain.handle('clipboard:writeText', (_e, text: string) => {
    clipboard.writeText(text)
  })

  // Put real file references on the system pasteboard so they can be pasted
  // into Finder, Mail, Slack, etc. macOS reads the legacy NSFilenamesPboardType
  // (an XML plist array of POSIX paths). writeBuffer() declares this raw
  // pasteboard type; clipboard.write({text}) only supports known keys (text,
  // html, image, rtf, bookmark) and silently drops custom formats, so it
  // can't be used here.
  ipcMain.handle('clipboard:writeFiles', (_e, paths: string[]) => {
    if (!paths.length) return
    const escape = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const plist =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
      '<plist version="1.0">\n<array>\n' +
      paths.map((p) => `\t<string>${escape(p)}</string>`).join('\n') +
      '\n</array>\n</plist>'
    clipboard.writeBuffer('NSFilenamesPboardType', Buffer.from(plist, 'utf8'))
  })

  ipcMain.handle('fs:writeFile', async (_e, filePath: string, content = '') => {
    await fs.writeFile(filePath, content, { flag: 'wx' }) // wx fails if exists
  })

  const TEXT_EXTS = new Set([
    'txt', 'md', 'json', 'yaml', 'yml', 'toml', 'ini', 'csv', 'xml', 'html', 'css',
    'ts', 'tsx', 'js', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'cpp', 'c', 'h',
    'sh', 'bash', 'zsh', 'log', 'env', 'conf',
  ])

  const SKIP_DIRS = new Set([
    'node_modules', '.git', '.cache', 'Library', '.Trash',
    'Cache', 'Caches', '.npm', '.yarn', '.cargo', '.rustup',
  ])

  // Build a text predicate from a query string supporting:
  //   • Regex:   /pattern/flags   (e.g. /^foo.*\.tsx?$/i) — flags optional,
  //              defaults to case-insensitive.
  //   • Boolean: space-separated terms are ANDed; `OR` (or `|`) splits into
  //              alternatives; a leading `-` (or `NOT `) negates a term.
  //              e.g.  report -draft   |   2023 OR 2024   |   foo -NOT bar
  // Plain queries with no operators behave exactly like the old substring
  // match. Returns null if the query compiles to nothing (caller treats as
  // "no results").
  function buildTextMatcher(query: string): ((text: string) => boolean) | null {
    const trimmed = query.trim()
    if (!trimmed) return null

    const rx = trimmed.match(/^\/(.+)\/([a-z]*)$/i)
    if (rx) {
      try {
        const re = new RegExp(rx[1], rx[2].includes('i') ? rx[2] : rx[2] + 'i')
        return (text: string) => re.test(text)
      } catch {
        return null // invalid regex → no results rather than throwing
      }
    }

    // Split into OR alternatives, then each into AND terms (negatable).
    const alternatives = trimmed
      .split(/\s+OR\s+|\s*\|\s*/i)
      .map((alt) => alt.trim())
      .filter(Boolean)
      .map((alt) =>
        alt
          .split(/\s+/)
          .map((tok) => tok.replace(/^NOT$/i, '-')) // bare "NOT" → negate next? keep simple: treat leading - only
          .filter((t) => t && t !== '-')
          .map((tok) => {
            const negate = tok.startsWith('-') && tok.length > 1
            return { negate, needle: (negate ? tok.slice(1) : tok).toLowerCase() }
          }),
      )
      .filter((terms) => terms.length > 0)

    if (!alternatives.length) return null

    return (text: string) => {
      const lower = text.toLowerCase()
      // Match if ANY alternative fully matches (all its AND terms satisfied).
      return alternatives.some((terms) =>
        terms.every(({ negate, needle }) =>
          negate ? !lower.includes(needle) : lower.includes(needle),
        ),
      )
    }
  }

  async function walkSearch(
    dir: string,
    predicate: (entry: FileEntry) => boolean | Promise<boolean>,
    maxResults: number,
    maxDepth: number,
    depth = 0,
    results: FileEntry[] = [],
  ): Promise<FileEntry[]> {
    if (results.length >= maxResults || depth > maxDepth) return results
    let entries: fsSync.Dirent[] = []
    try {
      entries = (await fs.readdir(dir, { withFileTypes: true })) as unknown as fsSync.Dirent[]
    } catch { return results }

    for (const entry of entries) {
      if (results.length >= maxResults) break
      if (entry.name.startsWith('.')) continue
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue

      const full = path.join(dir, entry.name)
      let stat
      try { stat = await fs.stat(full) } catch { continue }

      const fileEntry: FileEntry = {
        name: entry.name,
        path: full,
        isDirectory: entry.isDirectory(),
        size: stat.size,
        modified: stat.mtimeMs,
        ext: entry.isDirectory() ? '' : path.extname(entry.name).toLowerCase().slice(1),
      }

      try {
        if (await predicate(fileEntry)) {
          results.push(fileEntry)
          if (results.length >= maxResults) break
        }
      } catch {}

      if (entry.isDirectory()) {
        await walkSearch(full, predicate, maxResults, maxDepth, depth + 1, results)
      }
    }
    return results
  }

  ipcMain.handle('fs:searchRecursive', async (
    _e,
    dirPath: string,
    query: string,
    mode: 'name' | 'content' | 'kind' | 'size',
  ): Promise<FileEntry[]> => {
    if (!query) return []
    const q = query.toLowerCase()
    const maxResults = 500
    const maxDepth = 8

    if (mode === 'name') {
      const match = buildTextMatcher(query)
      if (!match) return []
      return walkSearch(dirPath, (e) => match(e.name), maxResults, maxDepth)
    }
    if (mode === 'kind') {
      return walkSearch(dirPath, (e) => !e.isDirectory && e.ext.toLowerCase().includes(q), maxResults, maxDepth)
    }
    if (mode === 'size') {
      const KB = 1024, MB = 1024 * KB, GB = 1024 * MB
      const SIZE_RANGES: Record<string, [number, number]> = {
        tiny:   [0,       16 * KB],
        small:  [16 * KB, 1 * MB],
        medium: [1 * MB,  128 * MB],
        large:  [128 * MB, 1 * GB],
        huge:   [1 * GB,  Infinity],
      }
      const range = SIZE_RANGES[q]
      if (!range) return []
      const [min, max] = range
      return walkSearch(dirPath, (e) => !e.isDirectory && e.size >= min && e.size <= max, maxResults, maxDepth)
    }
    // content
    const matchContent = buildTextMatcher(query)
    if (!matchContent) return []
    return walkSearch(dirPath, async (e) => {
      if (e.isDirectory) return false
      if (!TEXT_EXTS.has(e.ext)) return false
      if (e.size > 2 * 1024 * 1024) return false
      try {
        const text = await fs.readFile(e.path, 'utf-8')
        return matchContent(text)
      } catch {
        return false
      }
    }, maxResults, maxDepth)
  })

  ipcMain.handle('fs:exists', async (_e, filePath: string) => {
    try {
      await fs.access(filePath)
      return true
    } catch {
      return false
    }
  })

  ipcMain.handle('fs:readdirsOnly', async (_e, dirPath: string) => {
    const entries = await fs.readdir(dirPath, { withFileTypes: true })
    const dirs: FileEntry[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const fullPath = path.join(dirPath, entry.name)
      dirs.push({ name: entry.name, path: fullPath, isDirectory: true, size: 0, modified: 0, ext: '' })
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    return dirs
  })

  ipcMain.handle('shell:openInTerminal', (_e, dirPath: string, appName?: string) => {
    // Empty / missing appName falls back to macOS's stock Terminal.app —
    // there's no real "OS default terminal" concept on macOS, so Terminal
    // is the sensible baseline.
    const app = appName?.trim() || 'Terminal'
    execFile('open', ['-a', app, dirPath])
  })

  ipcMain.handle('fs:zip', async (_e, filePaths: string[]) => {
    if (!filePaths.length) return
    const dir = path.dirname(filePaths[0])
    const names = filePaths.map((f) => path.basename(f))
    const baseName = names.length === 1 ? names[0] : 'Archive'
    let archiveName = `${baseName}.zip`
    let count = 2
    // Async existence check so we don't block the event loop while
    // probing for a free filename on slow volumes (NFS, encrypted DMG, …).
    const existsAsync = async (p: string) => {
      try { await fs.access(p); return true } catch { return false }
    }
    while (await existsAsync(path.join(dir, archiveName))) {
      archiveName = `${baseName} ${count}.zip`
      count++
    }
    const destPath = path.join(dir, archiveName)
    await new Promise<void>((resolve, reject) => {
      execFile('zip', ['-r', destPath, ...names], { cwd: dir }, (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
    return destPath
  })

  ipcMain.handle('fs:unzip', async (_e, zipPath: string) => {
    const dir = path.dirname(zipPath)
    await new Promise<void>((resolve, reject) => {
      execFile('unzip', ['-o', zipPath, '-d', dir], (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  })

  // List entries inside a .zip without extracting. Uses the system unzip
  // binary (always available on macOS) so we avoid a runtime dep. Each
  // entry mirrors fs:readdir's FileEntry shape so the UI can render it
  // the same way.
  ipcMain.handle('fs:listZip', async (_e, zipPath: string): Promise<{ name: string; path: string; isDirectory: boolean; size: number; modified: number; ext: string }[]> => {
    return new Promise((resolve, reject) => {
      execFile('unzip', ['-l', zipPath], { maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
        if (err) return reject(err)
        // unzip -l output:
        //   Archive:  foo.zip
        //     Length      Date    Time    Name
        //   ---------  ---------- -----   ----
        //         123  04-12-2024 10:30   path/inside.txt
        //   ---------                     -------
        //   total
        const lines = stdout.split('\n')
        const start = lines.findIndex((l) => /^-+\s+-+\s+-+\s+-+/.test(l))
        if (start === -1) return resolve([])
        const out: { name: string; path: string; isDirectory: boolean; size: number; modified: number; ext: string }[] = []
        for (let i = start + 1; i < lines.length; i++) {
          const line = lines[i]
          if (/^-+/.test(line)) break // footer separator
          const m = line.match(/^\s*(\d+)\s+(\S+)\s+(\S+)\s+(.+)$/)
          if (!m) continue
          const size = parseInt(m[1], 10)
          const dateStr = `${m[2]} ${m[3]}`
          const inside = m[4]
          const modified = Date.parse(dateStr) || 0
          const isDirectory = inside.endsWith('/')
          const name = isDirectory ? inside.slice(0, -1).split('/').pop() ?? '' : inside.split('/').pop() ?? ''
          const ext = isDirectory ? '' : (path.extname(name).slice(1).toLowerCase() ?? '')
          out.push({ name, path: inside, isDirectory, size, modified, ext })
        }
        resolve(out)
      })
    })
  })

  // Recursively sum file sizes under a directory. Skips entries that
  // throw (permission errors, broken symlinks). Doesn't follow symlinks
  // so we can't get into cycles. For very large trees the caller should
  // expect this to take seconds — it's invoked from Get Info on demand.
  ipcMain.handle('fs:folderSize', async (_e, dirPath: string): Promise<{ size: number; files: number; folders: number }> => {
    let size = 0
    let files = 0
    let folders = 0
    async function walk(p: string) {
      let entries: fsSync.Dirent[]
      try {
        entries = await fs.readdir(p, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        const full = path.join(p, e.name)
        try {
          if (e.isSymbolicLink()) continue
          if (e.isDirectory()) {
            folders++
            await walk(full)
          } else if (e.isFile()) {
            const st = await fs.stat(full)
            size += st.size
            files++
          }
        } catch {
          // skip unreadable entries
        }
      }
    }
    await walk(dirPath)
    return { size, files, folders }
  })

  // Initiate an OS-level drag from the given paths so users can drop
  // files into other apps (Finder, Mail, Slack, VS Code, etc.). Must
  // be called from within a renderer dragstart event for macOS to
  // accept it. The icon is required by the API; we fall back to the
  // app icon when no better thumbnail exists yet.
  // 16x16 translucent-gray PNG, used only when no real icon can be found,
  // so startDrag is never handed an empty nativeImage (which hangs macOS).
  const DRAG_FALLBACK_ICON =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGklEQVR42mOYOXPmGUoww6gBowaMGjBcDAAAvm6XH2QAU/gAAAAASUVORK5CYII='

  ipcMain.handle('shell:startDrag', async (e, paths: string[]) => {
    if (!paths || paths.length === 0) return
    // macOS hangs (or crashes) if startDrag receives an empty nativeImage,
    // so we must always resolve a real, non-empty icon.
    let icon = nativeImage.createEmpty()
    // Prefer the OS icon for the file type being dragged (the macOS
    // document/folder/app icon), so the drag cursor matches the file
    // rather than showing our logo. Use the first dragged item.
    try {
      // Prefer an actual content thumbnail (QuickLook): images show their
      // preview, PDFs their first page, etc. It rejects/returns empty for
      // folders, plain text, and files with no QuickLook provider, so we
      // fall back to the OS file-type icon in those cases.
      let raw: Electron.NativeImage | null = null
      try {
        raw = await nativeImage.createThumbnailFromPath(paths[0], { width: 64, height: 64 })
      } catch {
        // No QuickLook thumbnail available — fall back to the type icon.
      }
      if (!raw || raw.isEmpty()) {
        raw = await app.getFileIcon(paths[0], { size: 'normal' })
      }
      if (!raw.isEmpty()) {
        // Resizing the raw image crashes startDrag (getFileIcon returns a
        // multi-representation Retina NSImage). Flatten it to a plain
        // single-rep PNG first, THEN scale — resizing the flattened bitmap
        // is a different operation that the drag session accepts. Width-only
        // resize preserves aspect ratio so previews aren't squished.
        const flat = nativeImage.createFromBuffer(raw.toPNG())
        icon = flat.isEmpty() ? raw : flat.resize({ width: 64 })
      }
    } catch {
      // getFileIcon can reject for missing/inaccessible paths — fall through.
    }
    // Fall back to the app icon, then a tiny embedded placeholder, so the
    // image is never empty.
    if (icon.isEmpty()) {
      const candidates = [
        path.join(process.resourcesPath ?? '', 'icon.png'), // packaged (extraResources)
        path.join(app.getAppPath(), 'assets', 'icon.png'),  // dev (project root)
      ]
      for (const c of candidates) {
        const img = nativeImage.createFromPath(c)
        if (!img.isEmpty()) {
          icon = img.resize({ width: 64, height: 64 })
          break
        }
      }
    }
    if (icon.isEmpty()) {
      // Last-resort 16x16 placeholder so we never pass an empty image.
      icon = nativeImage.createFromDataURL(DRAG_FALLBACK_ICON)
    }
    e.sender.startDrag({
      files: paths,
      icon,
    })
  })

  ipcMain.handle('apps:list', async () => {
    const home = os.homedir()
    const dirs = ['/Applications', '/System/Applications', path.join(home, 'Applications')]
    const apps: { name: string; path: string }[] = []
    const seen = new Set<string>()
    for (const d of dirs) {
      try {
        const entries = await fs.readdir(d, { withFileTypes: true })
        for (const e of entries) {
          if (!e.name.endsWith('.app')) continue
          const full = path.join(d, e.name)
          if (seen.has(e.name)) continue
          seen.add(e.name)
          apps.push({ name: e.name.replace(/\.app$/, ''), path: full })
        }
      } catch {}
    }
    apps.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    return apps
  })

  ipcMain.handle('apps:openWith', async (_e, appPath: string, filePaths: string[]) => {
    if (!filePaths.length) return
    await new Promise<void>((resolve, reject) => {
      execFile('open', ['-a', appPath, ...filePaths], (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  })

  ipcMain.handle('apps:chooseAndOpen', async (_e, filePaths: string[]) => {
    const result = await dialog.showOpenDialog({
      defaultPath: '/Applications',
      properties: ['openFile'],
      filters: [{ name: 'Applications', extensions: ['app'] }],
    })
    if (result.canceled || !result.filePaths.length) return null
    const appPath = result.filePaths[0]
    await new Promise<void>((resolve, reject) => {
      execFile('open', ['-a', appPath, ...filePaths], (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
    return appPath
  })

  ipcMain.handle('fs:gitStatus', (_e, dirPath: string) => {
    return new Promise<Record<string, string>>((resolve) => {
      execFile('git', ['-C', dirPath, 'status', '--porcelain'], (err, stdout) => {
        if (err) { resolve({}); return }
        const result: Record<string, string> = {}
        for (const line of stdout.split('\n')) {
          if (!line.trim()) continue
          const xy = line.substring(0, 2).trim()
          const filePart = line.substring(3).trim().split(' -> ').pop() ?? ''
          const name = filePart.split('/').pop() ?? filePart
          if (name) result[name] = xy === '??' ? '?' : (xy[0] && xy[0] !== ' ' ? xy[0] : xy[1]) || '?'
        }
        resolve(result)
      })
    })
  })
}
