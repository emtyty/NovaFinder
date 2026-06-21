import { useCallback, useEffect, useRef, useState } from 'react'
import { useTagStore } from './store/tagStore'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { Toolbar } from './components/Toolbar'
import { TabBar } from './components/TabBar'
import { Sidebar } from './components/Sidebar/Sidebar'
import { FileList } from './components/FileList/FileList'
import { PreviewPanel } from './components/PreviewPanel/PreviewPanel'
import { StatusBar } from './components/StatusBar'
import { GetInfoModal } from './components/GetInfoModal'
import { useKeyboard } from './hooks/useKeyboard'
import { useTheme } from './hooks/useTheme'
import { usePaneStore } from './store/paneStore'
import { useFileOps } from './hooks/useFileOps'
import { PromptModal } from './components/PromptModal'
import { ConflictModal } from './components/ConflictModal'
import { ProgressOverlay } from './components/ProgressOverlay'
import { UpdateNotification } from './components/UpdateNotification'
import { SettingsModal } from './components/SettingsModal'
import { useSearchStore } from './store/searchStore'
import { useSettingsStore } from './store/settingsStore'
import type { CommandId } from '../shared/commands'
import { RECENTS_PATH } from './store/recentsStore'
import { SMART_PATH_PREFIX } from './store/smartFoldersStore'
import { TAG_PATH_PREFIX } from './store/tagStore'

export default function App() {
  const [showPreview, setShowPreview] = useState(true)
  const [previewFile, setPreviewFile] = useState<{ path: string; ext: string } | null>(null)
  const [globalInfoPath, setGlobalInfoPath] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)

  useEffect(() => {
    const off = window.fs.onOpenSettings(() => setShowSettings(true))
    return () => { off() }
  }, [])
  const reloadFn = useRef<(() => void) | null>(null)
  const newFolderFn = useRef<(() => void) | null>(null)
  const newFileFn = useRef<(() => void) | null>(null)
  const startRenameFn = useRef<(() => void) | null>(null)

  const { activePaneId, panes, activeTabId, showHidden, setSelection } = usePaneStore()
  const { duplicate, copyPath, deleteFiles, deletePermanent } = useFileOps(handleRefresh)
  const shortcuts = useSettingsStore((s) => s.shortcuts)
  const loadTags = useTagStore((s) => s.load)
  const { theme, mode: themeMode, toggle: toggleTheme } = useTheme()
  const clearSearch = useSearchStore((s) => s.clear)
  useEffect(() => { loadTags() }, [loadTags])

  // Clear search whenever the active path/tab changes so it doesn't persist
  // across tab switches or folder navigations.
  const activePath = panes[activePaneId].path
  const activeTab = activeTabId[activePaneId]
  useEffect(() => { clearSearch() }, [activePath, activePaneId, activeTab, clearSearch])

  function handleRefresh() { reloadFn.current?.() }

  async function handleSelectAll() {
    const pane = panes[activePaneId]
    // Virtual views (Recents, Smart Folders, Tag) don't have a real directory
    // to readdir — skip rather than throw ENOENT. Select-all from the
    // visible list could be wired through FileList in a follow-up.
    if (pane.path === RECENTS_PATH || pane.path.startsWith(SMART_PATH_PREFIX) || pane.path.startsWith(TAG_PATH_PREFIX)) return
    const entries = await window.fs.readdir(pane.path, showHidden)
    setSelection(activePaneId, entries.map((e) => e.path))
  }

  function toggleQuickLook(p: string) {
    if (previewFile?.path === p) {
      setPreviewFile(null)
    } else {
      const ext = p.split('.').pop() ?? ''
      setPreviewFile({ path: p, ext })
      setShowPreview(true)
    }
  }

  // Single dispatcher for the remappable file-action commands, shared by the
  // in-app keyboard (useKeyboard) and the native menu bar (via app:command).
  function runCommand(id: CommandId) {
    const st = usePaneStore.getState()
    const pane = st.panes[st.activePaneId]
    const sel = pane.selection
    switch (id) {
      case 'newFolder': newFolderFn.current?.(); break
      case 'newFile': newFileFn.current?.(); break
      case 'getInfo': if (sel.length === 1) setGlobalInfoPath(sel[0]); break
      case 'rename': startRenameFn.current?.(); break
      case 'duplicate': if (sel.length) duplicate(sel); break
      case 'moveToTrash': if (sel.length) deleteFiles(sel); break
      case 'deletePermanent': if (sel.length) deletePermanent(sel); break
      case 'copyPath': if (sel.length) copyPath(sel); break
      case 'openInTerminal': window.fs.openInTerminal(pane.path, useSettingsStore.getState().terminalApp); break
      case 'quickLook': if (sel.length === 1) toggleQuickLook(sel[0]); break
      case 'refresh': handleRefresh(); break
    }
  }
  // Stable wrapper so keydown/menu listeners don't re-subscribe each render,
  // while still calling the latest runCommand (fresh state/closures).
  const runCommandRef = useRef(runCommand)
  runCommandRef.current = runCommand
  const dispatchCommand = useCallback((id: CommandId) => runCommandRef.current(id), [])

  // Native menu item clicks arrive here as command ids.
  useEffect(() => window.fs.onCommand((id) => dispatchCommand(id as CommandId)), [dispatchCommand])

  // Keep the native menu-bar accelerators in sync with the user's overrides.
  useEffect(() => { window.fs.setMenuShortcuts(shortcuts) }, [shortcuts])

  useKeyboard({
    onRefresh: handleRefresh,
    onSelectAll: handleSelectAll,
    runCommand: dispatchCommand,
  })

  return (
    <div className="flex h-screen w-screen items-center justify-center overflow-hidden p-[2px] bg-background text-foreground">

      <div className="relative flex h-full w-full flex-col overflow-hidden rounded-xl border border-border/60 bg-background shadow-window">

        <PanelGroup direction="horizontal" className="flex-1 overflow-hidden min-h-0">
          {/* Sidebar — full height, top drag region covers traffic lights */}
          <Panel defaultSize={18} minSize={12} maxSize={28} className="bg-sidebar border-r border-border/40 flex flex-col">
            <div className="flex-shrink-0 [-webkit-app-region:drag]" style={{ height: 52 }} />
            <div className="flex-1 overflow-hidden min-h-0">
              <Sidebar />
            </div>
          </Panel>
          <PanelResizeHandle className="w-px hover:bg-primary/60 transition-colors" />

          {/* Main content column: toolbar + file list + preview */}
          <Panel defaultSize={82} minSize={40} className="content-area flex flex-col overflow-hidden">
            <Toolbar
              showPreview={showPreview}
              onTogglePreview={() => setShowPreview((v) => !v)}
              onRefresh={handleRefresh}
              onNewFolder={() => newFolderFn.current?.()}
              onNewFile={() => newFileFn.current?.()}
              theme={theme}
              themeMode={themeMode}
              onToggleTheme={toggleTheme}
            />
            <PanelGroup direction="horizontal" className="flex-1 overflow-hidden min-h-0">
              <Panel defaultSize={60} minSize={25} className="bg-background/40 flex flex-col">
                <TabBar paneId="left" />
                <div className="flex-1 min-h-0">
                  <FileList
                    paneId="left"
                    onPreview={(path, ext) => setPreviewFile({ path, ext })}
                    onClearPreview={() => setPreviewFile(null)}
                    registerReload={(fn) => { reloadFn.current = fn }}
                    registerNewFolder={(fn) => { newFolderFn.current = fn }}
                    registerNewFile={(fn) => { newFileFn.current = fn }}
                    registerStartRename={(fn) => { startRenameFn.current = fn }}
                  />
                </div>
              </Panel>

              {showPreview && (
                <>
                  <PanelResizeHandle className="w-px hover:bg-primary/60 transition-colors" />
                  <Panel defaultSize={40} minSize={20} maxSize={60} className="bg-sidebar/80 border-l border-border/40">
                    <PreviewPanel
                      filePath={previewFile?.path ?? null}
                      ext={previewFile?.ext ?? ''}
                    />
                  </Panel>
                </>
              )}
            </PanelGroup>
          </Panel>
        </PanelGroup>

        <StatusBar />
      </div>

      {globalInfoPath && <GetInfoModal filePath={globalInfoPath} onClose={() => setGlobalInfoPath(null)} />}
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      <PromptModal />
      <ConflictModal />
      <ProgressOverlay />
      <UpdateNotification />
    </div>
  )
}
