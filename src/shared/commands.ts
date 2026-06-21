// Single source of truth for remappable file-action commands.
//
// Imported by BOTH the main process (to build the native menu bar) and the
// renderer (in-app keyboard handling, context-menu hints, the Settings UI),
// so a shortcut the user remaps updates everywhere at once.
//
// Accelerators are stored in Electron's canonical accelerator syntax
// (e.g. "Shift+Cmd+N") because the native menu consumes that format directly;
// the renderer parses the same string to match KeyboardEvents.

export type CommandId =
  | 'newFolder'
  | 'newFile'
  | 'getInfo'
  | 'rename'
  | 'duplicate'
  | 'moveToTrash'
  | 'deletePermanent'
  | 'copyPath'
  | 'openInTerminal'
  | 'quickLook'
  | 'refresh'

export type CommandDef = {
  id: CommandId
  label: string
  /** Electron accelerator; '' means unbound by default. */
  defaultAccel: string
  /** Acts on the current selection (no-ops when nothing is selected). */
  needsSelection?: boolean
}

// Order here is also the order shown in the File menu and the Settings tab.
export const COMMANDS: CommandDef[] = [
  { id: 'newFolder',      label: 'New Folder',       defaultAccel: 'Shift+Cmd+N' },
  { id: 'newFile',        label: 'New File',         defaultAccel: '' },
  { id: 'getInfo',        label: 'Get Info',         defaultAccel: 'Cmd+I', needsSelection: true },
  { id: 'rename',         label: 'Rename',           defaultAccel: '',      needsSelection: true },
  { id: 'duplicate',      label: 'Duplicate',        defaultAccel: 'Cmd+D', needsSelection: true },
  { id: 'moveToTrash',    label: 'Move to Trash',    defaultAccel: 'Cmd+Backspace', needsSelection: true },
  { id: 'deletePermanent', label: 'Delete Immediately', defaultAccel: 'Alt+Cmd+Backspace', needsSelection: true },
  { id: 'copyPath',       label: 'Copy Path',        defaultAccel: 'Alt+Cmd+C', needsSelection: true },
  { id: 'openInTerminal', label: 'Open in Terminal', defaultAccel: 'Alt+Cmd+T' },
  { id: 'quickLook',      label: 'Quick Look',       defaultAccel: 'Space', needsSelection: true },
  { id: 'refresh',        label: 'Refresh',          defaultAccel: 'Cmd+R' },
]

export const COMMAND_MAP: Record<CommandId, CommandDef> =
  COMMANDS.reduce((m, c) => { m[c.id] = c; return m }, {} as Record<CommandId, CommandDef>)

export type ShortcutOverrides = Partial<Record<CommandId, string>>

/** Effective accelerator for a command: the user override if set, else the default. */
export function resolveAccel(id: CommandId, overrides: ShortcutOverrides): string {
  const override = overrides[id]
  return override !== undefined ? override : (COMMAND_MAP[id]?.defaultAccel ?? '')
}

// ─── Display formatting (⇧⌘N style) ───

// Which canonical token each modifier maps to, and the Apple display order.
const MOD_CANON: Record<string, 'Ctrl' | 'Alt' | 'Shift' | 'Cmd'> = {
  Ctrl: 'Ctrl', Control: 'Ctrl',
  Alt: 'Alt', Option: 'Alt',
  Shift: 'Shift',
  Cmd: 'Cmd', Command: 'Cmd', Meta: 'Cmd', CmdOrCtrl: 'Cmd',
}
const MOD_DISPLAY: Record<'Ctrl' | 'Alt' | 'Shift' | 'Cmd', string> = {
  Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Cmd: '⌘',
}
const MOD_ORDER = ['Ctrl', 'Alt', 'Shift', 'Cmd'] as const
const KEY_SYMBOL: Record<string, string> = {
  Backspace: '⌫', Delete: '⌦', Enter: '↵', Return: '↵',
  Escape: '⎋', Space: 'Space', Tab: '⇥',
  Up: '↑', Down: '↓', Left: '←', Right: '→',
}

/** Turn "Shift+Cmd+N" into "⇧⌘N" for display. Empty string for unbound. */
export function formatAccel(accel: string): string {
  if (!accel) return ''
  const present = new Set<'Ctrl' | 'Alt' | 'Shift' | 'Cmd'>()
  let key = ''
  for (const p of accel.split('+')) {
    const mod = MOD_CANON[p]
    if (mod) present.add(mod)
    else key = p
  }
  const mods = MOD_ORDER.filter((m) => present.has(m)).map((m) => MOD_DISPLAY[m]).join('')
  return mods + (KEY_SYMBOL[key] ?? key.toUpperCase())
}
