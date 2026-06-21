import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useFileOps } from '../../renderer/hooks/useFileOps'
import { usePaneStore } from '../../renderer/store/paneStore'
import { useClipboardStore } from '../../renderer/store/clipboardStore'
import { useHistoryStore } from '../../renderer/store/historyStore'

const paneState = (path = '/home') => ({
  path,
  selection: [],
  lastSelected: null,
  history: [path],
  historyIndex: 0,
  sortKey: 'name' as const,
  sortDir: 'asc' as const,
  tagFilter: null,
})

const mockFs = {
  exists: vi.fn().mockResolvedValue(false),
  stat: vi.fn().mockResolvedValue({ isDirectory: false, size: 0, modified: 0, created: 0 }),
  rename: vi.fn().mockResolvedValue(undefined),
  copy: vi.fn().mockResolvedValue(undefined),
  delete: vi.fn().mockResolvedValue(undefined),
  deletePermanent: vi.fn().mockResolvedValue([]),
  confirmDelete: vi.fn().mockResolvedValue(true),
  trashWithUndo: vi.fn().mockImplementation(async (paths: string[]) =>
    paths.map((p) => ({ src: p, dst: `/Users/u/.Trash/${p.split('/').pop()}` })),
  ),
  move: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  writeClipboardText: vi.fn().mockResolvedValue(undefined),
  writeClipboardFiles: vi.fn().mockResolvedValue(undefined),
}

beforeEach(() => {
  vi.clearAllMocks()
  ;(window as any).fs = mockFs
  usePaneStore.setState({
    activePaneId: 'left',
    panes: { left: paneState('/home'), right: paneState('/home') },
    showHidden: false,
    syncPanes: false,
    viewMode: 'icon',
  })
  useClipboardStore.setState({ files: [], operation: null })
  useHistoryStore.setState({ past: [], future: [] })
})

describe('useFileOps', () => {
  describe('cut / copy', () => {
    it('cut sets clipboard to cut operation', async () => {
      const { result } = renderHook(() => useFileOps())
      await act(() => result.current.cut(['/home/a.txt']))
      expect(useClipboardStore.getState().operation).toBe('cut')
      expect(useClipboardStore.getState().files).toEqual(['/home/a.txt'])
    })

    it('copy sets clipboard to copy operation', async () => {
      const { result } = renderHook(() => useFileOps())
      await act(() => result.current.copy(['/home/b.txt']))
      expect(useClipboardStore.getState().operation).toBe('copy')
      expect(useClipboardStore.getState().files).toEqual(['/home/b.txt'])
    })
  })

  describe('paste', () => {
    it('calls fs.move for a cut operation', async () => {
      // Cut-paste uses move() (not rename) so it survives cross-device moves
      // (EXDEV) by falling back to copy+delete in the main process.
      useClipboardStore.setState({ files: ['/tmp/file.txt'], operation: 'cut' })
      const { result } = renderHook(() => useFileOps())
      await act(() => result.current.paste('/home'))
      expect(mockFs.move).toHaveBeenCalledWith('/tmp/file.txt', '/home/file.txt')
    })

    it('calls fs.copy for a copy operation to a different dir', async () => {
      useClipboardStore.setState({ files: ['/tmp/photo.jpg'], operation: 'copy' })
      const { result } = renderHook(() => useFileOps())
      await act(() => result.current.paste('/home/pics'))
      expect(mockFs.copy).toHaveBeenCalledWith('/tmp/photo.jpg', '/home/pics/photo.jpg')
    })

    it('generates a unique name when copying to the same dir', async () => {
      useClipboardStore.setState({ files: ['/home/note.txt'], operation: 'copy' })
      mockFs.exists.mockResolvedValueOnce(true).mockResolvedValue(false)
      const { result } = renderHook(() => useFileOps())
      await act(() => result.current.paste('/home'))
      expect(mockFs.copy).toHaveBeenCalledWith('/home/note.txt', '/home/note 2.txt')
    })

    it('clears clipboard after a cut-paste', async () => {
      useClipboardStore.setState({ files: ['/tmp/x.txt'], operation: 'cut' })
      const { result } = renderHook(() => useFileOps())
      await act(() => result.current.paste('/home'))
      expect(useClipboardStore.getState().operation).toBeNull()
    })

    it('does not clear clipboard after a copy-paste', async () => {
      useClipboardStore.setState({ files: ['/tmp/x.txt'], operation: 'copy' })
      const { result } = renderHook(() => useFileOps())
      await act(() => result.current.paste('/home'))
      expect(useClipboardStore.getState().operation).toBe('copy')
    })

    it('is a no-op when clipboard is empty', async () => {
      const { result } = renderHook(() => useFileOps())
      await act(() => result.current.paste('/home'))
      expect(mockFs.rename).not.toHaveBeenCalled()
      expect(mockFs.copy).not.toHaveBeenCalled()
    })
  })

  describe('deleteFiles', () => {
    it('passes all paths in a single trashWithUndo call', async () => {
      const { result } = renderHook(() => useFileOps())
      await act(() => result.current.deleteFiles(['/home/a.txt', '/home/b.txt']))
      expect(mockFs.trashWithUndo).toHaveBeenCalledTimes(1)
      expect(mockFs.trashWithUndo).toHaveBeenCalledWith(['/home/a.txt', '/home/b.txt'])
    })

    it('clears selection after delete', async () => {
      usePaneStore.getState().setSelection('left', ['/home/a.txt'])
      const { result } = renderHook(() => useFileOps())
      await act(() => result.current.deleteFiles(['/home/a.txt']))
      expect(usePaneStore.getState().panes.left.selection).toEqual([])
    })

    it('pushes a trash op to history with src/dst pairs', async () => {
      const { result } = renderHook(() => useFileOps())
      await act(() => result.current.deleteFiles(['/home/a.txt']))
      const past = useHistoryStore.getState().past
      expect(past).toHaveLength(1)
      expect(past[0]).toMatchObject({
        kind: 'trash',
        pairs: [{ src: '/home/a.txt', dst: '/Users/u/.Trash/a.txt' }],
      })
    })

    it('passes successfully-deleted paths to onReload for optimistic UI', async () => {
      const onReload = vi.fn()
      const { result } = renderHook(() => useFileOps(onReload))
      await act(() => result.current.deleteFiles(['/home/a.txt', '/home/b.txt']))
      expect(onReload).toHaveBeenCalledWith(['/home/a.txt', '/home/b.txt'])
    })

    it('does not push history when nothing was trashed', async () => {
      mockFs.trashWithUndo.mockResolvedValueOnce([])
      const { result } = renderHook(() => useFileOps())
      await act(() => result.current.deleteFiles(['/home/a.txt']))
      expect(useHistoryStore.getState().past).toHaveLength(0)
    })
  })

  describe('copyPath', () => {
    it('writes paths joined by newline to the system clipboard', async () => {
      const { result } = renderHook(() => useFileOps())
      await act(() => result.current.copyPath(['/a.txt', '/b.txt']))
      expect(mockFs.writeClipboardText).toHaveBeenCalledWith('/a.txt\n/b.txt')
    })
  })

  describe('rename', () => {
    it('calls fs.rename with the new full path', async () => {
      const { result } = renderHook(() => useFileOps())
      await act(() => result.current.rename('/home/old.txt', 'new.txt'))
      expect(mockFs.rename).toHaveBeenCalledWith('/home/old.txt', '/home/new.txt')
    })
  })

  describe('newFolder', () => {
    it('calls fs.mkdir with the given name when no collision', async () => {
      mockFs.exists.mockResolvedValue(false)
      const { result } = renderHook(() => useFileOps())
      await act(() => result.current.newFolder('/home', 'Projects'))
      expect(mockFs.mkdir).toHaveBeenCalledWith('/home/Projects')
    })

    it('uses a numbered name when the folder already exists', async () => {
      mockFs.exists.mockResolvedValueOnce(true).mockResolvedValue(false)
      const { result } = renderHook(() => useFileOps())
      await act(() => result.current.newFolder('/home', 'Projects'))
      expect(mockFs.mkdir).toHaveBeenCalledWith('/home/Projects 2')
    })
  })
})
