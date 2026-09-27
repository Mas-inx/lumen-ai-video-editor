import { Command } from 'cmdk'
import {
  Aperture,
  AudioLines,
  Blend,
  Captions,
  Clapperboard,
  Crosshair,
  Layers,
  ListVideo,
  Move,
  ScanLine,
  Video,
  Copy,
  Download,
  FilePlus,
  Film,
  Flag,
  FolderOpen,
  Grid3x3,
  FolderArchive,
  History,
  Keyboard,
  SlidersVertical,
  Magnet,
  Music,
  Play,
  Plus,
  Redo2,
  Save,
  Scissors,
  Settings2,
  SkipBack,
  SkipForward,
  Sparkles,
  Trash,
  Type,
  Undo2,
  UnfoldHorizontal,
  Upload,
} from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { AiSparkle } from '@/components/brand'
import { Kbd } from '@/components/ui/kbd'
import { placeTitle } from '@/editor/placement'
import { playback, usePlayback } from '@/editor/playback'
import { TITLE_PRESETS } from '@/editor/presets'
import { allSequences, openSequenceId } from '@/editor/sequences'
import { dispatch, getProject, useEditor } from '@/editor/store'
import { openTimeline } from '@/editor/timeline-nav'
import { useUI, type LeftTab } from '@/editor/ui-store'
import { STARTERS } from '@/features/copilot/suggestions'
import { sendPrompt } from '@/features/copilot/store'
import { actions } from '@/features/shell/actions'
import { SHORTCUTS, shortcutFor } from '@/features/shell/shortcuts'
import { collectProject } from '@/project/session'
import { pickSubtitles, saveSubtitles } from '@/project/subtitle-files'

/** Shortcuts already offered above under a friendlier name. */
const LISTED = new Set(['split', 'duplicate', 'delete', 'ripple', 'marker', 'undo', 'redo', 'import', 'play', 'start', 'end', 'zoom-fit', 'guides', 'snapping', 'export', 'queue', 'save', 'save-as', 'open', 'new', 'help', 'palette', 'nest'])

const ui = () => useUI.getState()

export function CommandPalette() {
  const open = useUI((s) => s.paletteOpen)
  const setOpen = useUI((s) => s.setPaletteOpen)
  const [query, setQuery] = useState('')

  const run = (fn: () => void) => () => {
    setOpen(false)
    setQuery('')
    // Let the dialog close before acting (focus returns to the editor).
    requestAnimationFrame(fn)
  }
  const panel = (tab: LeftTab) => run(() => ui().setLeftTab(tab))
  const sequenceRef = useEditor((s) => s.project.sequence)
  const stored = useEditor((s) => s.project.sequences)
  // Built from the pieces it depends on, so it only changes when timelines do.
  const timelines = useMemo(() => (open ? allSequences({ ...getProject(), sequence: sequenceRef, sequences: stored }) : []), [open, sequenceRef, stored])
  const openId = openSequenceId({ sequence: sequenceRef })

  return (
    <Command.Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) setQuery('')
      }}
      label="Command palette"
      loop
      overlayClassName="fixed inset-0 z-[90] bg-black/45 backdrop-blur-[2px] data-[state=open]:animate-fade-in"
      contentClassName="popover fixed top-[13%] left-1/2 z-[95] w-[min(640px,calc(100vw-32px))] -translate-x-1/2 overflow-hidden rounded-2xl data-[state=open]:animate-pop-in"
    >
      <div className="flex items-center gap-3 border-b border-line px-4">
        <AiSparkle className="size-[18px] shrink-0" />
        <Command.Input
          value={query}
          onValueChange={setQuery}
          placeholder="Search actions — or describe an edit for Copilot…"
          className="h-14 min-w-0 flex-1 bg-transparent text-md text-fg outline-none placeholder:text-fg-4"
        />
        <Kbd combo="esc" />
      </div>

      <Command.List className="max-h-[min(440px,58vh)] overflow-y-auto overscroll-contain p-2 [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pt-2.5 [&_[cmdk-group-heading]]:pb-1.5 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-fg-4 [&_[cmdk-group-heading]]:uppercase">
        {query.trim() && (
          <Command.Group heading="Copilot" forceMount>
            <Item forceMount value={`ask-copilot ${query}`} icon={<AiSparkle />} onSelect={run(() => void sendPrompt(query))} hint="↵">
              <span className="text-fg-3">Ask Copilot:</span> <span className="text-fg">“{query}”</span>
            </Item>
          </Command.Group>
        )}

        {!query.trim() && (
          <Command.Group heading="Suggested">
            {STARTERS.slice(0, 4).map((s) => (
              <Item key={s.title} value={s.title} icon={<AiSparkle />} onSelect={run(() => void sendPrompt(s.prompt))}>
                {s.title}
                <span className="ml-2 text-fg-4">{s.subtitle}</span>
              </Item>
            ))}
          </Command.Group>
        )}

        <Command.Group heading="Edit">
          <Item icon={<Scissors />} shortcut={shortcutFor('split')} onSelect={run(actions.split)}>
            Split at playhead
          </Item>
          <Item icon={<Copy />} shortcut={shortcutFor('duplicate')} onSelect={run(actions.duplicateSelection)}>
            Duplicate selection
          </Item>
          <Item icon={<Trash />} shortcut={shortcutFor('delete')} onSelect={run(() => actions.deleteSelection(false))}>
            Delete selection
          </Item>
          <Item icon={<Trash />} shortcut={shortcutFor('ripple')} keywords={['close gap']} onSelect={run(() => actions.deleteSelection(true))}>
            Ripple delete
          </Item>
          <Item icon={<Flag />} shortcut={shortcutFor('marker')} onSelect={run(actions.addMarker)}>
            Add marker
          </Item>
          <Item icon={<Undo2 />} shortcut={shortcutFor('undo')} onSelect={run(actions.undo)}>
            Undo
          </Item>
          <Item icon={<Redo2 />} shortcut={shortcutFor('redo')} onSelect={run(actions.redo)}>
            Redo
          </Item>
        </Command.Group>

        <Command.Group heading="Insert">
          <Item icon={<Upload />} shortcut={shortcutFor('import')} onSelect={run(actions.importMedia)}>
            Import media…
          </Item>
          {TITLE_PRESETS.slice(0, 4).map((p) => (
            <Item
              key={p.id}
              icon={<Type />}
              keywords={['text', 'title']}
              onSelect={run(() => {
                const id = placeTitle(p.id, usePlayback.getState().frame)
                if (id) ui().select([id])
              })}
            >
              Add {p.name.toLowerCase()} title
            </Item>
          ))}
          <Item icon={<Film />} onSelect={run(() => dispatch('track.add', { kind: 'video' }))}>
            Add video track
          </Item>
          <Item icon={<AudioLines />} onSelect={run(() => dispatch('track.add', { kind: 'audio' }))}>
            Add audio track
          </Item>
        </Command.Group>

        <Command.Group heading="Timelines & footage">
          <Item icon={<Layers />} keywords={['sequence', 'timeline', 'new', 'version', 'cut']} onSelect={run(() => dispatch('sequence.create', {}))}>
            New timeline
          </Item>
          {timelines
            .filter((t) => t.id !== openId)
            .map((t) => (
              <Item key={t.id} icon={t.multicam ? <Video /> : <Layers />} keywords={['timeline', 'sequence', 'open', 'switch']} onSelect={run(() => openTimeline(t.id))}>
                Open timeline “{t.name}”
              </Item>
            ))}
          <Item icon={<Layers />} shortcut={shortcutFor('nest')} keywords={['compound', 'group', 'precompose', 'sequence']} onSelect={run(actions.nestSelection)}>
            Nest selection into a timeline
          </Item>
          <Item icon={<Video />} keywords={['multicam', 'multi-camera', 'angles', 'sync', 'cameras', 'podcast', 'interview']} onSelect={run(() => ui().setMulticam({ assetIds: [] }))}>
            Make a multicam clip…
          </Item>
          <Item icon={<ScanLine />} keywords={['scene', 'shot', 'detect', 'cuts', 'split']} onSelect={run(() => void actions.detectScenes('split'))}>
            Split clip at scene cuts
          </Item>
          <Item icon={<ScanLine />} keywords={['scene', 'shot', 'detect', 'markers']} onSelect={run(() => void actions.detectScenes('markers'))}>
            Mark scene cuts
          </Item>
          <Item icon={<Move />} keywords={['stabilize', 'stabilise', 'shake', 'steady', 'warp']} onSelect={run(() => void actions.stabilize())}>
            Stabilize clip
          </Item>
          <Item icon={<Crosshair />} keywords={['track', 'tracking', 'follow', 'pin', 'motion']} onSelect={run(() => actions.trackMotion())}>
            Track motion…
          </Item>
        </Command.Group>

        <Command.Group heading="Playback">
          <Item icon={<Play />} shortcut={shortcutFor('play')} onSelect={run(() => playback.toggle())}>
            Play / pause
          </Item>
          <Item icon={<SkipBack />} shortcut={shortcutFor('start')} onSelect={run(actions.goToStart)}>
            Go to start
          </Item>
          <Item icon={<SkipForward />} shortcut={shortcutFor('end')} onSelect={run(actions.goToEnd)}>
            Go to end
          </Item>
        </Command.Group>

        <Command.Group heading="View">
          <Item icon={<UnfoldHorizontal />} shortcut={shortcutFor('zoom-fit')} onSelect={run(actions.zoomToFit)}>
            Zoom timeline to fit
          </Item>
          <Item icon={<Grid3x3 />} shortcut={shortcutFor('guides')} onSelect={run(() => ui().setShowGuides(!ui().showGuides))}>
            Toggle safe-area guides
          </Item>
          <Item icon={<Magnet />} shortcut={shortcutFor('snapping')} onSelect={run(() => ui().toggleSnapping())}>
            Toggle snapping
          </Item>
          <Item icon={<Clapperboard />} onSelect={panel('media')}>
            Show media
          </Item>
          <Item icon={<Music />} onSelect={panel('audio')}>
            Show music & sound effects
          </Item>
          <Item icon={<Sparkles />} onSelect={panel('effects')}>
            Show effects
          </Item>
          <Item icon={<Blend />} onSelect={panel('transitions')}>
            Show transitions
          </Item>
          <Item icon={<Aperture />} onSelect={panel('looks')}>
            Show color looks
          </Item>
          <Item icon={<AiSparkle />} onSelect={panel('generate')}>
            Generate with AI
          </Item>
        </Command.Group>

        <Command.Group heading="Project">
          <Item icon={<Upload />} shortcut={shortcutFor('export')} onSelect={run(() => ui().setExportOpen(true))}>
            Export…
          </Item>
          <Item icon={<ListVideo />} shortcut={shortcutFor('queue')} keywords={['batch', 'render', 'queue', 'exports']} onSelect={run(() => ui().setQueueOpen(true))}>
            Render queue…
          </Item>
          <Item icon={<Save />} shortcut={shortcutFor('save')} onSelect={run(() => void actions.save())}>
            Save
          </Item>
          <Item icon={<Save />} shortcut={shortcutFor('save-as')} onSelect={run(actions.saveAs)}>
            Save as…
          </Item>
          <Item icon={<FolderOpen />} shortcut={shortcutFor('open')} onSelect={run(actions.open)}>
            Open project…
          </Item>
          <Item icon={<FilePlus />} shortcut={shortcutFor('new')} onSelect={run(actions.home)}>
            New project…
          </Item>
          <Item icon={<Download />} shortcut={shortcutFor('import')} onSelect={run(actions.importMedia)}>
            Import media…
          </Item>
          <Item icon={<Captions />} keywords={['srt', 'vtt', 'captions', 'subtitles']} onSelect={run(pickSubtitles)}>
            Import subtitles (SRT / VTT)…
          </Item>
          <Item icon={<Captions />} keywords={['srt', 'captions', 'subtitles', 'export']} onSelect={run(() => void saveSubtitles('srt'))}>
            Export captions as SRT…
          </Item>
          <Item icon={<Captions />} keywords={['vtt', 'webvtt', 'captions', 'subtitles', 'export']} onSelect={run(() => void saveSubtitles('vtt'))}>
            Export captions as WebVTT…
          </Item>
          <Item
            icon={<Settings2 />}
            onSelect={run(() => {
              ui().clearSelection()
              ui().setRightTab('inspector')
            })}
          >
            Project settings
          </Item>
          <Item icon={<Keyboard />} shortcut={shortcutFor('help')} onSelect={run(() => ui().setShortcutsOpen(true))}>
            Keyboard shortcuts
          </Item>
          <Item icon={<Plus />} onSelect={run(() => ui().setLeftTab('generate'))} keywords={['ai', 'b-roll', 'image', 'voice']}>
            Generate B-roll, voice or music
          </Item>
          <Item icon={<History />} keywords={['backup', 'restore', 'undo', 'autosave']} onSelect={run(() => ui().setVersionsOpen(true))}>
            Version history…
          </Item>
          <Item icon={<FolderArchive />} keywords={['consolidate', 'package', 'archive', 'move', 'backup']} onSelect={run(() => void collectProject())}>
            Collect project and media…
          </Item>
          <Item icon={<SlidersVertical />} keywords={['audio', 'volume', 'eq', 'compressor', 'meters']} onSelect={run(() => ui().setRightTab('mixer'))}>
            Open the mixer
          </Item>
        </Command.Group>

        {/* Everything with a shortcut, so every command can be found by name. */}
        <Command.Group heading="More commands">
          {SHORTCUTS.filter((s) => !LISTED.has(s.id)).map((s) => (
            <Item key={s.id} icon={<Keyboard />} shortcut={s.keys[0]} keywords={[s.group]} onSelect={run(s.run)}>
              {s.label}
            </Item>
          ))}
        </Command.Group>

      </Command.List>

      <div className="flex items-center gap-4 border-t border-line px-4 py-2.5 text-2xs text-fg-4">
        <span className="flex items-center gap-1.5">
          <Kbd combo="up" />
          <Kbd combo="down" /> navigate
        </span>
        <span className="flex items-center gap-1.5">
          <Kbd combo="enter" /> run
        </span>
        <span className="ml-auto flex items-center gap-1.5">
          <AiSparkle className="size-3" /> Type any edit in plain words
        </span>
      </div>
    </Command.Dialog>
  )
}

function Item({
  icon,
  shortcut,
  hint,
  children,
  onSelect,
  value,
  keywords,
  forceMount,
}: {
  icon: ReactNode
  shortcut?: string
  hint?: string
  children: ReactNode
  onSelect: () => void
  value?: string
  keywords?: string[]
  forceMount?: boolean
}) {
  return (
    <Command.Item
      value={value}
      keywords={keywords}
      forceMount={forceMount}
      onSelect={onSelect}
      className="flex h-10 cursor-default items-center gap-3 rounded-[9px] px-2.5 text-sm text-fg-2 select-none data-[selected=true]:bg-white/[0.07] data-[selected=true]:text-fg [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-fg-3"
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {shortcut && <Kbd combo={shortcut} />}
      {hint && <span className="text-2xs text-fg-4">{hint}</span>}
    </Command.Item>
  )
}
