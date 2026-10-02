import { playback } from '@/editor/playback'
import { useUI } from '@/editor/ui-store'
import { actions } from './actions'

export interface Shortcut {
  id: string
  label: string
  group: 'Playback' | 'Editing' | 'Multicam' | 'Tools' | 'View' | 'App'
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
  { id: 'back-second', label: 'Back one second', group: 'Playback', keys: ['shift+left'], run: () => actions.stepSeconds(-1) },
  { id: 'fwd-second', label: 'Forward one second', group: 'Playback', keys: ['shift+right'], run: () => actions.stepSeconds(1) },
  { id: 'play-in-out', label: 'Play in to out', group: 'Playback', keys: ['shift+space'], run: actions.playInToOut },
  { id: 'render', label: 'Render previews in to out (or the whole timeline)', group: 'Playback', keys: ['enter'], run: actions.renderPreviews },
  { id: 'go-in', label: 'Go to in point', group: 'Playback', keys: ['shift+i'], run: actions.goToIn },
  { id: 'go-out', label: 'Go to out point', group: 'Playback', keys: ['shift+o'], run: actions.goToOut },
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
  { id: 'copy', label: 'Copy', group: 'Editing', keys: ['mod+c'], run: actions.copy },
  { id: 'cut', label: 'Cut', group: 'Editing', keys: ['mod+x'], run: actions.cut },
  { id: 'paste', label: 'Paste at playhead', group: 'Editing', keys: ['mod+v'], run: () => actions.paste('free') },
  { id: 'paste-insert', label: 'Paste insert (push clips later)', group: 'Editing', keys: ['mod+shift+v'], run: () => actions.paste('insert') },
  { id: 'paste-attributes', label: 'Paste attributes…', group: 'Editing', keys: ['mod+alt+v'], run: actions.pasteAttributes },
  { id: 'mark-in', label: 'Mark in', group: 'Editing', keys: ['i'], run: actions.markIn },
  { id: 'mark-out', label: 'Mark out', group: 'Editing', keys: ['o'], run: actions.markOut },
  { id: 'mark-clip', label: 'Mark in and out around selection', group: 'Editing', keys: ['x'], run: actions.markSelection },
  { id: 'clear-in-out', label: 'Clear in and out', group: 'Editing', keys: ['alt+x'], run: actions.clearInOut },
  { id: 'lift', label: 'Lift (leave a gap)', group: 'Editing', keys: [';'], run: actions.lift },
  { id: 'extract', label: 'Extract (close the gap)', group: 'Editing', keys: ["'"], run: actions.extract },
  { id: 'freeze', label: 'Freeze frame', group: 'Editing', keys: ['shift+f'], run: actions.freezeFrame },
  { id: 'detach-audio', label: 'Detach / reattach audio', group: 'Editing', keys: ['mod+l'], run: actions.toggleAudioLink },
  { id: 'group', label: 'Group clips', group: 'Editing', keys: ['mod+g'], run: actions.group },
  { id: 'crossfade', label: 'Crossfade with the clip before', group: 'Editing', keys: ['mod+shift+d'], run: actions.crossfade },
  { id: 'ungroup', label: 'Ungroup clips', group: 'Editing', keys: ['mod+shift+g'], run: actions.ungroup },
  { id: 'nest', label: 'Nest selection into a timeline', group: 'Editing', keys: ['mod+alt+n'], run: actions.nestSelection },
  { id: 'open-nested', label: 'Open the nested timeline', group: 'Editing', keys: ['mod+alt+enter'], run: () => actions.openNested() },

  // Multicam
  ...Array.from({ length: 9 }, (_, i): Shortcut => ({ id: `angle-${i + 1}`, label: `Cut to camera ${i + 1}`, group: 'Multicam', keys: [String(i + 1)], run: () => actions.cutToAngle(i + 1) })),

  // Tools
  { id: 'tool-select', label: 'Select tool', group: 'Tools', keys: ['v'], run: () => ui().setTool('select') },
  { id: 'tool-blade', label: 'Blade tool', group: 'Tools', keys: ['b', 'c'], run: () => ui().setTool('blade') },
  { id: 'tool-roll', label: 'Roll tool (move a cut)', group: 'Tools', keys: ['r'], run: () => ui().setTool('roll') },
  { id: 'tool-slip', label: 'Slip tool (change the footage in place)', group: 'Tools', keys: ['y'], run: () => ui().setTool('slip') },
  { id: 'tool-slide', label: 'Slide tool (move between neighbours)', group: 'Tools', keys: ['u'], run: () => ui().setTool('slide') },
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
  { id: 'queue', label: 'Render queue', group: 'App', keys: ['mod+shift+e'], run: () => ui().setQueueOpen(true), global: true },
  { id: 'save', label: 'Save', group: 'App', keys: ['mod+s'], run: () => void actions.save(), global: true },
  { id: 'save-as', label: 'Save as…', group: 'App', keys: ['mod+shift+s'], run: actions.saveAs, global: true },
  { id: 'open', label: 'Open project…', group: 'App', keys: ['mod+o'], run: actions.open, global: true },
  { id: 'new', label: 'New project', group: 'App', keys: ['mod+n'], run: actions.home, global: true },
  { id: 'help', label: 'Keyboard shortcuts', group: 'App', keys: ['?'], run: () => ui().setShortcutsOpen(true) },
]

export const shortcutFor = (id: string) => SHORTCUTS.find((s) => s.id === id)?.keys[0]
