import { playback } from '@/editor/playback'
import { useUI } from '@/editor/ui-store'
import { actions } from './actions'

export interface Shortcut {
  id: string
  label: string
  group: 'Playback' | 'Editing' | 'Tools' | 'View' | 'App'
  /** One or more combos, e.g. "mod+shift+z". The first is shown in the UI. */
  keys: string[]
  run: () => void
  /** Also fires while typing in a text field. */
  global?: boolean
}

const ui = () => useUI.getState()

export const SHORTCUTS: Shortcut[] = [
  // Playback
  { id: 'play', label: 'Play / pause', group: 'Playback', keys: ['space'], run: () => playback.toggle() },
  { id: 'shuttle-back', label: 'Play backward (tap to speed up)', group: 'Playback', keys: ['j'], run: () => playback.shuttle(-1) },
  { id: 'stop', label: 'Stop', group: 'Playback', keys: ['k'], run: () => playback.pause() },
  { id: 'shuttle-fwd', label: 'Play forward (tap to speed up)', group: 'Playback', keys: ['l'], run: () => playback.shuttle(1) },
  { id: 'prev-frame', label: 'Previous frame', group: 'Playback', keys: ['left'], run: () => playback.step(-1) },
  { id: 'next-frame', label: 'Next frame', group: 'Playback', keys: ['right'], run: () => playback.step(1) },
  { id: 'back-second', label: 'Back one second', group: 'Playback', keys: ['shift+left'], run: () => playback.step(-30) },
  { id: 'fwd-second', label: 'Forward one second', group: 'Playback', keys: ['shift+right'], run: () => playback.step(30) },
  { id: 'prev-edit', label: 'Previous edit point', group: 'Playback', keys: ['up'], run: () => actions.jumpEdit(-1) },
  { id: 'next-edit', label: 'Next edit point', group: 'Playback', keys: ['down'], run: () => actions.jumpEdit(1) },
  { id: 'start', label: 'Go to start', group: 'Playback', keys: ['home'], run: actions.goToStart },
  { id: 'end', label: 'Go to end', group: 'Playback', keys: ['end'], run: actions.goToEnd },

  // Editing
  { id: 'split', label: 'Split at playhead', group: 'Editing', keys: ['s', 'mod+b'], run: actions.split },
  { id: 'delete', label: 'Delete', group: 'Editing', keys: ['delete', 'backspace'], run: () => actions.deleteSelection(false) },
  { id: 'ripple', label: 'Ripple delete', group: 'Editing', keys: ['shift+delete', 'shift+backspace'], run: () => actions.deleteSelection(true) },
  { id: 'duplicate', label: 'Duplicate', group: 'Editing', keys: ['mod+d'], run: actions.duplicateSelection },
  { id: 'select-all', label: 'Select all clips', group: 'Editing', keys: ['mod+a'], run: actions.selectAll },
  { id: 'deselect', label: 'Deselect', group: 'Editing', keys: ['esc'], run: () => ui().clearSelection() },
  { id: 'undo', label: 'Undo', group: 'Editing', keys: ['mod+z'], run: actions.undo },
  { id: 'redo', label: 'Redo', group: 'Editing', keys: ['mod+shift+z', 'mod+y'], run: actions.redo },
  { id: 'marker', label: 'Add marker', group: 'Editing', keys: ['m'], run: actions.addMarker },

  // Tools
  { id: 'tool-select', label: 'Select tool', group: 'Tools', keys: ['v'], run: () => ui().setTool('select') },
  { id: 'tool-blade', label: 'Blade tool', group: 'Tools', keys: ['b', 'c'], run: () => ui().setTool('blade') },
  { id: 'snapping', label: 'Toggle snapping', group: 'Tools', keys: ['n'], run: () => ui().toggleSnapping() },

  // View
  { id: 'zoom-in', label: 'Zoom in', group: 'View', keys: ['=', '+'], run: () => actions.zoom(1.35) },
  { id: 'zoom-out', label: 'Zoom out', group: 'View', keys: ['-'], run: () => actions.zoom(1 / 1.35) },
  { id: 'zoom-fit', label: 'Zoom to fit', group: 'View', keys: ['shift+z'], run: actions.zoomToFit },
  { id: 'guides', label: 'Toggle safe-area guides', group: 'View', keys: ['g'], run: () => ui().setShowGuides(!ui().showGuides) },

  // App
  { id: 'palette', label: 'Command palette', group: 'App', keys: ['mod+k'], run: () => ui().setPaletteOpen(!ui().paletteOpen), global: true },
  { id: 'copilot', label: 'Toggle Copilot', group: 'App', keys: ['mod+j'], run: actions.toggleCopilot, global: true },
  { id: 'import', label: 'Import media', group: 'App', keys: ['mod+i'], run: actions.importMedia, global: true },
  { id: 'export', label: 'Export', group: 'App', keys: ['mod+e'], run: () => ui().setExportOpen(true), global: true },
  { id: 'save', label: 'Save', group: 'App', keys: ['mod+s'], run: () => void actions.save(), global: true },
  { id: 'save-as', label: 'Save as…', group: 'App', keys: ['mod+shift+s'], run: actions.saveAs, global: true },
  { id: 'open', label: 'Open project…', group: 'App', keys: ['mod+o'], run: actions.open, global: true },
  { id: 'new', label: 'New project', group: 'App', keys: ['mod+n'], run: actions.home, global: true },
  { id: 'help', label: 'Keyboard shortcuts', group: 'App', keys: ['?'], run: () => ui().setShortcutsOpen(true) },
]

export const shortcutFor = (id: string) => SHORTCUTS.find((s) => s.id === id)?.keys[0]
