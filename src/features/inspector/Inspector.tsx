import { AudioLines, Blend, Copy, Ellipsis, Film, Image as ImageIcon, Layers, MousePointerClick, Trash, Type } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { AiSparkle } from '@/components/brand'
import { Button, IconButton } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Kbd } from '@/components/ui/kbd'
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/ui/menu'
import { Row, Section } from '@/components/ui/section'
import { Segmented } from '@/components/ui/segmented'
import { Select } from '@/components/ui/select'
import { clipEnd, projectDuration } from '@/editor/ops'
import { dispatch, useEditor } from '@/editor/store'
import type { Clip, ClipKind } from '@/editor/types'
import { useUI } from '@/editor/ui-store'
import { assetThumb } from '@/features/assets/shared'
import { sendPrompt } from '@/features/copilot/store'
import { actions } from '@/features/shell/actions'
import { cn } from '@/lib/cn'
import { formatDuration, formatTimecode } from '@/lib/time'
import { CropSection } from './CropSection'
import { MaskSection } from './MaskSection'
import { AnimateSection, AudioSection, ColorSections, CompositingSection, EffectsSection, Space3DSection, SpeedSection, TextSection, TransformSection } from './sections'

export function Inspector() {
  const selection = useUI((s) => s.selection)
  const clips = useEditor(useShallow((s) => selection.map((id) => s.project.clips[id]).filter(Boolean)))
  return (
    <div className="h-full overflow-y-auto">
      {clips.length === 0 && <ProjectInspector />}
      {clips.length === 1 && <ClipInspector key={clips[0].id} clip={clips[0]} />}
      {clips.length > 1 && <MultiInspector clips={clips} />}
    </div>
  )
}

// ─── Single clip ─────────────────────────────────────────────────────────

type Tab = 'video' | 'text' | 'color' | 'audio' | 'speed' | 'animate'

const TABS: Record<ClipKind, Tab[]> = {
  video: ['video', 'color', 'audio', 'speed', 'animate'],
  image: ['video', 'color', 'animate'],
  text: ['text', 'video', 'animate'],
  audio: ['audio', 'speed'],
  adjustment: ['color', 'video'],
}

const TAB_LABEL: Record<Tab, string> = { video: 'Video', text: 'Text', color: 'Color', audio: 'Audio', speed: 'Speed', animate: 'Animate' }

const KIND_ICON: Record<ClipKind, typeof Film> = { video: Film, image: ImageIcon, audio: AudioLines, text: Type, adjustment: Blend }
const KIND_LABEL: Record<ClipKind, string> = { video: 'Video', image: 'Image', audio: 'Audio', text: 'Title', adjustment: 'Adjustment layer' }

// Remember the last tab per clip kind so the inspector feels stable while hopping between clips.
const lastTab: Partial<Record<ClipKind, Tab>> = {}

function ClipInspector({ clip }: { clip: Clip }) {
  const fps = useEditor((s) => s.project.settings.fps)
  const asset = useEditor((s) => (clip.assetId ? s.project.assets[clip.assetId] : undefined))
  const tabs = TABS[clip.kind]
  const [tab, setTab] = useState<Tab>(() => (lastTab[clip.kind] && tabs.includes(lastTab[clip.kind]!) ? lastTab[clip.kind]! : tabs[0]))
  useEffect(() => {
    lastTab[clip.kind] = tab
  }, [clip.kind, tab])
  const Icon = KIND_ICON[clip.kind]
  const thumb = asset && asset.kind !== 'audio' ? assetThumb(asset, clip.inPoint / fps + 0.5) : undefined
  const [name, setName] = useState(clip.name)
  useEffect(() => setName(clip.name), [clip.name])

  return (
    <div>
      <div className="flex items-center gap-3 px-4 pt-4 pb-3">
        <div className="relative grid h-11 w-[72px] shrink-0 place-items-center overflow-hidden rounded-lg bg-white/[0.05] shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)]">
          {thumb ? <img src={thumb} alt="" className="h-full w-full object-cover" /> : <Icon className="size-4 text-fg-3" />}
        </div>
        <div className="min-w-0 flex-1">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name.trim() && name !== clip.name && dispatch('clip.update', { ids: [clip.id], patch: { name: name.trim() } })}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') e.currentTarget.blur()
            }}
            className="-ml-1 w-full truncate rounded-md bg-transparent px-1 py-0.5 text-md font-semibold text-fg outline-none hover:bg-white/[0.04] focus:bg-white/[0.06] focus:ring-1 focus:ring-accent/60"
          />
          <div className="mt-0.5 flex items-center gap-1.5 text-2xs text-fg-4">
            <span className="rounded bg-white/[0.06] px-1 py-px font-medium text-fg-3">{KIND_LABEL[clip.kind]}</span>
            <span className="font-mono tabular">
              {formatTimecode(clip.start, fps)} → {formatTimecode(clipEnd(clip), fps)}
            </span>
            <span>· {formatDuration(clip.duration, fps)}</span>
          </div>
        </div>
        <Menu>
          <MenuTrigger asChild>
            <IconButton label="Clip actions">
              <Ellipsis />
            </IconButton>
          </MenuTrigger>
          <MenuContent align="end">
            <MenuItem icon={<Copy />} shortcut="mod+d" onSelect={actions.duplicateSelection}>
              Duplicate
            </MenuItem>
            <MenuItem icon={<AiSparkle />} onSelect={() => void sendPrompt(clip.kind === 'audio' ? 'Remove the long pauses from this' : 'Make this look cinematic')}>
              {clip.kind === 'audio' ? 'Clean up with Copilot' : 'Grade with Copilot'}
            </MenuItem>
            <MenuSeparator />
            <MenuItem icon={<Trash />} danger shortcut="delete" onSelect={() => actions.deleteSelection(false)}>
              Delete
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>

      {tabs.length > 1 && (
        <div className="border-b border-line px-4 pb-3">
          <Segmented stretch value={tab} onChange={setTab} options={tabs.map((t) => ({ value: t, label: TAB_LABEL[t] }))} />
        </div>
      )}

      {tab === 'video' && (
        <>
          {clip.kind !== 'adjustment' && <TransformSection clip={clip} />}
          {(clip.kind === 'video' || clip.kind === 'image') && <CropSection clip={clip} />}
          {(clip.kind === 'video' || clip.kind === 'image' || clip.kind === 'adjustment') && <MaskSection clip={clip} />}
          {clip.kind !== 'adjustment' && <Space3DSection clip={clip} />}
          {clip.kind !== 'text' && clip.kind !== 'adjustment' && <CompositingSection clip={clip} />}
          <EffectsSection clip={clip} />
        </>
      )}
      {tab === 'text' && <TextSection clip={clip} />}
      {tab === 'color' && <ColorSections clips={[clip]} />}
      {tab === 'audio' && <AudioSection clip={clip} fps={fps} />}
      {tab === 'speed' && <SpeedSection clips={[clip]} fps={fps} />}
      {tab === 'animate' && <AnimateSection clip={clip} fps={fps} />}
    </div>
  )
}

// ─── Multiple clips ──────────────────────────────────────────────────────

function MultiInspector({ clips }: { clips: Clip[] }) {
  const fps = useEditor((s) => s.project.settings.fps)
  const visual = clips.filter((c) => c.kind === 'video' || c.kind === 'image' || c.kind === 'adjustment')
  const timed = clips.filter((c) => c.kind === 'video' || c.kind === 'audio')
  return (
    <div>
      <div className="flex items-center gap-3 px-4 pt-4 pb-3">
        <div className="grid size-11 place-items-center rounded-lg bg-accent/15 text-accent-2">
          <Layers className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-md font-semibold text-fg">{clips.length} clips selected</div>
          <div className="text-2xs text-fg-4">Changes apply to every selected clip</div>
        </div>
        <IconButton label="Delete" shortcut="delete" onClick={() => actions.deleteSelection(false)}>
          <Trash />
        </IconButton>
      </div>
      {visual.length > 0 && <ColorSections clips={visual} />}
      {timed.length > 0 && <SpeedSection clips={timed} fps={fps} />}
      {!visual.length && !timed.length && <p className="px-4 py-6 text-sm text-fg-3">These clips don’t share editable properties.</p>}
    </div>
  )
}

// ─── Project ─────────────────────────────────────────────────────────────

const CANVASES = [
  { id: '16:9', label: 'Widescreen', w: 1920, h: 1080 },
  { id: '4k', label: '4K UHD', w: 3840, h: 2160 },
  { id: '9:16', label: 'Vertical', w: 1080, h: 1920 },
  { id: '1:1', label: 'Square', w: 1080, h: 1080 },
  { id: '4:5', label: 'Portrait', w: 1080, h: 1350 },
]

const BACKGROUNDS = ['#000000', '#0b0b12', '#ffffff', '#1d1b2e', '#12281f', '#2b1522']

function ProjectInspector() {
  const project = useEditor((s) => s.project)
  const { settings } = project
  const [name, setName] = useState(project.name)
  useEffect(() => setName(project.name), [project.name])
  const current = CANVASES.find((c) => c.w === settings.width && c.h === settings.height)

  return (
    <div>
      <div className="px-4 pt-4 pb-3">
        <div className="text-2xs font-semibold tracking-wider text-fg-4 uppercase">Project</div>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && name !== project.name && dispatch('project.update', { name: name.trim() })}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
          className="mt-1.5 h-9 text-md font-semibold"
        />
      </div>

      <Section title="Canvas">
        <div className="grid grid-cols-5 gap-1.5">
          {CANVASES.map((c) => {
            const active = current?.id === c.id
            const ratio = c.w / c.h
            return (
              <button
                key={c.id}
                type="button"
                title={`${c.label} · ${c.w}×${c.h}`}
                onClick={() => dispatch('project.update', { settings: { width: c.w, height: c.h } })}
                className={cn(
                  'flex flex-col items-center gap-1.5 rounded-lg py-2 text-2xs font-medium transition-colors',
                  active ? 'bg-accent/15 text-accent-2 shadow-[inset_0_0_0_1px_rgb(214_238_0/0.45)]' : 'bg-white/[0.035] text-fg-3 hover:bg-white/[0.06] hover:text-fg-2',
                )}
              >
                <span className="grid h-7 place-items-center">
                  <span className={cn('rounded-[3px] border-[1.5px]', active ? 'border-accent-2' : 'border-fg-4')} style={{ width: ratio >= 1 ? 26 : 26 * ratio, height: ratio >= 1 ? 26 / ratio : 26 }} />
                </span>
                {c.id === '4k' ? '4K' : c.id}
              </button>
            )
          })}
        </div>
        <div className="mt-3 space-y-1">
          <Row label="Resolution">
            <span className="font-mono text-sm text-fg-2 tabular">
              {settings.width} × {settings.height}
            </span>
          </Row>
          <Row label="Frame rate">
            <Select
              aria-label="Frame rate"
              value={String(settings.fps)}
              onChange={(v) => dispatch('project.update', { settings: { fps: Number(v) } })}
              options={['24', '25', '30', '50', '60'].map((f) => ({ value: f, label: `${f} fps` }))}
              className="w-full"
            />
          </Row>
          <Row label="Background">
            <div className="flex gap-1.5">
              {BACKGROUNDS.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={c}
                  onClick={() => dispatch('project.update', { settings: { background: c } })}
                  className={cn('size-5 rounded-full ring-1 ring-white/15 transition-transform hover:scale-110', settings.background === c && 'ring-2 ring-accent ring-offset-2 ring-offset-surface')}
                  style={{ background: c }}
                />
              ))}
            </div>
          </Row>
        </div>
      </Section>

      <Section title="Overview">
        <div className="grid grid-cols-2 gap-2">
          <Stat label="Duration" value={formatDuration(projectDuration(project), settings.fps)} />
          <Stat label="Clips" value={String(Object.keys(project.clips).length)} />
          <Stat label="Tracks" value={String(project.tracks.length)} />
          <Stat label="Media" value={String(Object.keys(project.assets).length)} />
        </div>
      </Section>

      <div className="p-4">
        <div className="ring-ai rounded-xl bg-white/[0.03] p-3.5">
          <div className="flex items-center gap-2 text-sm font-medium text-fg">
            <AiSparkle />
            Not sure where to start?
          </div>
          <p className="mt-1 text-xs leading-relaxed text-fg-3">Ask Copilot to review your edit — it watches the timeline and suggests what to fix first.</p>
          <Button size="sm" variant="secondary" className="mt-3" onClick={() => void sendPrompt('Review my edit and give me feedback')}>
            Review my edit
          </Button>
        </div>
        <div className="mt-4 flex items-start gap-2 px-1 text-xs text-fg-4">
          <MousePointerClick className="mt-0.5 size-3.5 shrink-0" />
          <span>
            Select a clip to edit it. Press <Kbd combo="?" className="mx-0.5 align-middle" /> for every shortcut.
          </span>
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-white/[0.035] px-3 py-2.5 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.04)]">
      <div className="text-2xs text-fg-4">{label}</div>
      <div className="mt-0.5 text-lg font-semibold tracking-tight text-fg tabular">{value}</div>
    </div>
  )
}
