import { useMemo, useState } from 'react'
import { ContextMenu, type MenuItem } from '../components/ContextMenu'
import { GetInfoModal } from '../components/GetInfoModal'
import { OpenWithModal } from '../components/OpenWithModal'
import { BatchRenameModal } from '../components/BatchRenameModal'
import { usePaneStore } from '../store/paneStore'
import { useClipboardStore } from '../store/clipboardStore'
import { useTagStore, type TagColor } from '../store/tagStore'
import { usePinnedStore } from '../store/pinnedStore'
import { useFileOps } from './useFileOps'
import { useSettingsStore } from '../store/settingsStore'
import { resolveAccel, formatAccel, type CommandId } from '../../shared/commands'

type Entry = { path: string; name: string; isDirectory: boolean; ext: string }

type Options = {
  paneId: 'left' | 'right'
  paneRef: React.RefObject<HTMLElement | null>
  reload: () => void
  onRequestRename?: (path: string) => void
  onRequestNew?: (type: 'folder' | 'file') => void
}

type MenuState =
  | { kind: 'item'; x: number; y: number; entry: Entry }
  | { kind: 'bg';   x: number; y: number; dirPath: string }

export function useFileMenu({ paneId, paneRef, reload, onRequestRename, onRequestNew }: Options) {
  const { panes, navigateTo, setSelection, newTab } = usePaneStore()
  const pane = panes[paneId]
  const { rename, deleteFiles, deletePermanent, paste, cut, copy, duplicate, copyPath } = useFileOps(reload)
  const clipboard = useClipboardStore()
  const toggleTag = useTagStore((s) => s.toggle)
  const getTags = useTagStore((s) => s.get)
  const { add: pinFolder } = usePinnedStore()

  const shortcuts = useSettingsStore((s) => s.shortcuts)
  // Display the resolved (override-aware) accelerator for remappable commands.
  const sc = (id: CommandId) => formatAccel(resolveAccel(id, shortcuts))

  const [menu, setMenu] = useState<MenuState | null>(null)
  const [infoPath, setInfoPath] = useState<string | null>(null)
  const [openWithPaths, setOpenWithPaths] = useState<string[] | null>(null)
  const [batchRenamePaths, setBatchRenamePaths] = useState<string[] | null>(null)

  function openMenu(e: React.MouseEvent, entry: Entry) {
    e.preventDefault()
    e.stopPropagation()
    openMenuAt(e.clientX, e.clientY, entry)
  }

  // Coordinate-based opener so the menu can be summoned by keyboard
  // (Menu key / Shift+F10) at the focused row, not just by right-click.
  function openMenuAt(x: number, y: number, entry: Entry) {
    if (!pane.selection.includes(entry.path)) setSelection(paneId, [entry.path], entry.path)
    setMenu({ kind: 'item', x, y, entry })
  }

  function openBgMenu(e: React.MouseEvent, dirPath: string) {
    e.preventDefault()
    openBgMenuAt(e.clientX, e.clientY, dirPath)
  }

  function openBgMenuAt(x: number, y: number, dirPath: string) {
    setSelection(paneId, [])
    setMenu({ kind: 'bg', x, y, dirPath })
  }

  const close = () => setMenu(null)

  const items: MenuItem[] = useMemo(() => {
    if (!menu) return []

    if (menu.kind === 'bg') {
      const dir = menu.dirPath
      const hasClipboard = clipboard.files.length > 0 && clipboard.operation !== null
      const out: MenuItem[] = []
      if (onRequestNew) {
        out.push(
          { label: 'New Folder', icon: 'new-folder', shortcut: sc('newFolder'), action: () => { close(); onRequestNew('folder') } },
          { label: 'New File',   icon: 'new-file',   shortcut: sc('newFile'), action: () => { close(); onRequestNew('file') } },
          { separator: true },
        )
      }
      out.push(
        { label: 'Paste', icon: 'paste', shortcut: '⌘V', action: () => paste(dir), disabled: !hasClipboard },
        { separator: true },
        { label: 'Open in Terminal', icon: 'open', shortcut: sc('openInTerminal'), action: () => window.fs.openInTerminal(dir, useSettingsStore.getState().terminalApp) },
        { separator: true },
        { label: 'Get Info', icon: 'info', shortcut: sc('getInfo'), action: () => setInfoPath(dir) },
        { label: 'Refresh',  icon: 'refresh', shortcut: sc('refresh'), action: () => reload() },
      )
      return out
    }

    const targetEntry = menu.entry
    const targets = pane.selection.length > 0 ? pane.selection : [targetEntry.path]
    const hasClipboard = clipboard.files.length > 0 && clipboard.operation !== null
    const firstName = targets[0].split('/').pop() ?? ''
    const countLabel = targets.length > 1 ? `${targets.length} items` : `"${firstName}"`
    const targetIsDir = targetEntry.isDirectory
    const targetIsZip = targetEntry.ext === 'zip'

    return [
      { label: 'Open', icon: 'open', shortcut: '↵', action: () => {
        if (targetIsDir) navigateTo(paneId, targetEntry.path)
        else window.fs.open(targetEntry.path)
      } },
      ...(targetIsDir ? [{ label: 'Open in New Tab' as const, icon: 'open' as const, action: () => newTab(paneId, targetEntry.path) }] : []),
      { label: 'Open with Default App', icon: 'open-default', action: () => window.fs.open(targets[0]) },
      { label: 'Open With…', icon: 'open-default', action: () => setOpenWithPaths(targets) },
      { label: 'Reveal in NovaFinder', icon: 'reveal', action: () => {
        const t = targets[0]
        const parent = t.replace(/\/[^/]+\/?$/, '') || '/'
        if (parent !== pane.path) navigateTo(paneId, parent)
        setSelection(paneId, [t], t)
      } },
      ...(targetIsDir ? [{ label: 'Open in Terminal' as const, icon: 'open' as const, action: () => window.fs.openInTerminal(targets[0], useSettingsStore.getState().terminalApp) }] : []),
      { label: 'Move to Trash', icon: 'trash', shortcut: sc('moveToTrash'), action: () => deleteFiles(targets), danger: true },
      { label: 'Delete Immediately…', icon: 'trash', shortcut: sc('deletePermanent'), action: () => deletePermanent(targets), danger: true },
      { separator: true },
      { label: `Compress ${countLabel}`, icon: 'duplicate', action: () => window.fs.zip(targets).then(reload).catch(() => {}) },
      ...(targetIsZip && targets.length === 1 ? [{ label: 'Extract Here' as const, icon: 'open' as const, action: () => window.fs.unzip(targets[0]).then(reload).catch(() => {}) }] : []),
      { separator: true },
      ...(targetIsDir && targets.length === 1 ? [{ label: 'Pin to Sidebar' as const, icon: 'copy-path' as const, action: () => pinFolder(targets[0], targets[0].split('/').pop() ?? targets[0]) }] : []),
      { label: 'Get Info', icon: 'info', shortcut: sc('getInfo'), action: () => setInfoPath(targets[0]) },
      { separator: true },
      { label: `Cut ${countLabel}`,  icon: 'cut',  shortcut: '⌘X', action: () => cut(targets) },
      { label: `Copy ${countLabel}`, icon: 'copy', shortcut: '⌘C', action: () => copy(targets) },
      { label: 'Paste', icon: 'paste', shortcut: '⌘V', action: () => paste(pane.path), disabled: !hasClipboard },
      { separator: true },
      { label: 'Duplicate', icon: 'duplicate', shortcut: sc('duplicate'), action: () => duplicate(targets) },
      { label: 'Copy Name', icon: 'copy-path', action: () => window.fs.writeClipboardText(targets.map((p) => p.split('/').pop() ?? p).join('\n')) },
      { label: 'Copy Path', icon: 'copy-path', shortcut: sc('copyPath'), action: () => copyPath(targets) },
      { separator: true },
      { label: targets.length > 1 ? `Rename ${targets.length} Items…` : 'Rename', icon: 'rename', action: () => {
        if (targets.length > 1) {
          setBatchRenamePaths(targets)
        } else if (onRequestRename) {
          onRequestRename(targets[0])
        } else {
          const cur = targets[0].split('/').pop() ?? ''
          const next = window.prompt('Rename', cur)
          if (next && next !== cur) rename(targets[0], next).catch((e) => alert(String(e)))
        }
      } },
      { separator: true },
      {
        tagsRow: true,
        selectedColors: targets.length === 1 ? getTags(targets[0]) : [],
        onToggle: (color) => { for (const p of targets) toggleTag(p, color as TagColor) },
      },
    ]
  }, [menu, pane.selection, pane.path, clipboard.files, clipboard.operation, shortcuts])

  const element = (
    <>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={items}
          onClose={close}
          boundsRef={paneRef}
        />
      )}
      {infoPath && <GetInfoModal filePath={infoPath} onClose={() => setInfoPath(null)} />}
      {openWithPaths && <OpenWithModal filePaths={openWithPaths} onClose={() => setOpenWithPaths(null)} />}
      {batchRenamePaths && (
        <BatchRenameModal
          paths={batchRenamePaths}
          onClose={() => setBatchRenamePaths(null)}
          onDone={reload}
        />
      )}
    </>
  )

  return { openMenu, openBgMenu, openMenuAt, openBgMenuAt, element }
}
