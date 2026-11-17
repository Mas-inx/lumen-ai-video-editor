/**
 * The Story panel: the storyboard the video is made from — scene cards in
 * order with their running time, edited in place, dragged into a new order,
 * linked to the clips that make them, and shown on the timeline. The Copilot
 * plans here, produces scene by scene, and revises one scene at a time.
 */
import {
  ArrowDown,
  ArrowUp,
  Box,
  ChartColumn,
  ChevronRight,
  Copy,
  Ellipsis,
  Film,
  GripVertical,
  Image,
  Link2,
  LocateFixed,
  Plus,
  Search,
  Shapes,
  Sparkles,
  Trash,
  Type,
  Unlink,
  Video,
  WandSparkles,
  X,
} from 'lucide-react'
import { useMemo, useState, type DragEvent, type ReactNode } from 'react'
import { toast } from 'sonner'
import { useShallow } from 'zustand/react/shallow'
import { AiSparkle } from '@/components/brand'
import { Button, IconButton } from '@/components/ui/button'
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/ui/menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ScrubInput } from '@/components/ui/scrub-input'
import { Select } from '@/components/ui/select'
import { Tip } from '@/components/ui/tooltip'
import { rankBroll, scriptSentences, type BrollCandidate } from '@/editor/broll'
import type { CommandInput } from '@/editor/commands'
import { playback } from '@/editor/playback'
import { dispatch, getProject, useEditor } from '@/editor/store'
import { plannedSeconds, SCENE_STATUSES, SCENE_TREATMENTS, sceneClips, sceneRange, sceneStarts } from '@/editor/storyboard'
import { STYLES, styleById } from '@/editor/styles'
import { openTimeline } from '@/editor/timeline-nav'
import type { SceneStatus, SceneTreatment, StoryboardScene, TransitionKind } from '@/editor/types'
import { TRANSITIONS } from '@/editor/presets'
import { useUI, ZOOM_MAX, ZOOM_MIN } from '@/editor/ui-store'
import { assetThumb, PanelHeader, scrollArea, SectionLabel } from '@/features/assets/shared'
import { sendPrompt, useCopilot } from '@/features/copilot/store'
import { anchorNextZoom, useViewport } from '@/features/timeline/viewport'
import { cn } from '@/lib/cn'
import { clamp } from '@/lib/math'
import { formatSeconds } from '@/lib/time'

const TREATMENT_ICON: Record<SceneTreatment, ReactNode> = {
  footage: <Video />,
  broll: <Film />,
  'kinetic-type': <Type />,
  infographic: <ChartColumn />,
  'generated-image': <Image />,
  'generated-video': <WandSparkles />,
  '3d': <Box />,
  'motion-graphic': <Shapes />,
  other: <Sparkles />,
}

const STATUS_STYLE: Record<SceneStatus, string> = {
  planned: 'bg-white/[0.06] text-fg-3',
  'in-progress': 'bg-warn/12 text-warn',
  done: 'bg-ok/12 text-ok',
}

const NEXT_STATUS: Record<SceneStatus, SceneStatus> = { planned: 'in-progress', 'in-progress': 'done', done: 'planned' }

const SCENE_MIME = 'application/x-lumen-scene'

/** “3.5s”, or m:ss past a minute. */
const secs = (s: number) => (s < 60 ? `${Math.round(s * 10) / 10}s` : formatSeconds(s))

type ScenePatch = CommandInput<'storyboard.updateScene'>['patch']

const updateScene = (id: string, patch: ScenePatch, key?: string) => {
  const res = dispatch('storyboard.updateScene', { id, patch }, key ? { coalesce: `scene:${id}:${key}` } : undefined)
  if (!res.ok) toast(res.error)
}

/** Opens the Copilot with a request, sent at once — or left in the box to finish when `send` is false. */
function askCopilot(text: string, send = true) {
  if (send) return void sendPrompt(text)
  useUI.getState().setRightTab('copilot')
  useCopilot.getState().setDraft(text)
}

/**
 * Shows a produced scene on the timeline: opens its timeline, selects its
 * clips, puts the playhead at its start and zooms so its stretch fills the view.
 */
function showOnTimeline(scene: StoryboardScene) {
  const before = sceneRange(getProject(), scene)
  if (!before) return void toast('This scene isn’t on a timeline yet')
  if (!before.open && !openTimeline(before.timelineId)) return
  const p = getProject()
  const range = sceneRange(p, scene)!
  playback.pause()
  playback.seek(range.from)
  const clips = sceneClips(p, scene)
  if (clips.length) useUI.getState().select(clips.map((c) => c.id))
  const width = useViewport.getState().width
  const seconds = Math.max(0.5, (range.to - range.from) / range.fps)
  const target = clamp((Math.max(240, width) - 120) / seconds, ZOOM_MIN, ZOOM_MAX)
  const { pxPerSecond, setZoom } = useUI.getState()
  // The timeline scrolls with a zoom, so a zoom that's already right is nudged to move it there.
  const next = Math.abs(target - pxPerSecond) > 0.01 ? target : pxPerSecond * 0.999 >= ZOOM_MIN ? pxPerSecond * 0.999 : pxPerSecond * 1.001
  anchorNextZoom(range.from / range.fps, 48)
  setZoom(next)
}

// When the Copilot drafts a storyboard, the Story panel opens so it can be reviewed.
useEditor.subscribe((s, prev) => {
  if (s.project.id !== prev.project.id || (prev.project.storyboard?.scenes.length ?? 0) > 0 || !s.project.storyboard?.scenes.length) return
  if (useCopilot.getState().busy) useUI.getState().setLeftTab('storyboard')
})

export function StoryboardPanel() {
  const storyboard = useEditor((s) => s.project.storyboard)
  const scenes = storyboard?.scenes ?? []
  const starts = useMemo(() => sceneStarts(storyboard), [storyboard])
  const [drag, setDrag] = useState<{ id: string; over: number } | null>(null)

  const addScene = (index = scenes.length) => {
    const res = dispatch('storyboard.addScenes', { scenes: [{ title: `Scene ${scenes.length + 1}` }], index })
    if (!res.ok) toast(res.error)
  }

  if (!storyboard || (!scenes.length && !storyboard.brief)) return <EmptyStoryboard onAdd={() => addScene()} />

  const total = plannedSeconds(storyboard)
  const done = scenes.filter((s) => s.status === 'done').length

  const drop = (e: DragEvent) => {
    e.preventDefault()
    if (drag) {
      const from = scenes.findIndex((s) => s.id === drag.id)
      const to = drag.over > from ? drag.over - 1 : drag.over
      if (from >= 0 && to !== from) dispatch('storyboard.moveScene', { id: drag.id, index: to })
    }
    setDrag(null)
  }

  return (
    <>
      <PanelHeader title="Storyboard">
        <IconButton label="Add a scene" onClick={() => addScene()}>
          <Plus />
        </IconButton>
        <Menu>
          <MenuTrigger asChild>
            <IconButton label="More">
              <Ellipsis />
            </IconButton>
          </MenuTrigger>
          <MenuContent align="end">
            <MenuItem icon={<AiSparkle />} onSelect={() => askCopilot('Look at the storyboard and suggest improvements: pacing, the hook, scene order and anything missing. Don’t change it until I agree.')}>
              Review the plan with Copilot
            </MenuItem>
            <MenuItem
              icon={<WandSparkles />}
              disabled={!scenes.some((s) => s.status !== 'done')}
              onSelect={() => askCopilot('Produce the storyboard scene by scene (use the video-director skill): every scene that isn’t done, in order, in the storyboard’s style — linking each scene’s clips to it when it’s made.')}
            >
              Produce the rest with Copilot
            </MenuItem>
            <MenuSeparator />
            <MenuItem icon={<Trash />} danger disabled={!scenes.length} onSelect={() => dispatch('storyboard.removeScenes', { ids: scenes.map((s) => s.id) })}>
              Remove every scene
            </MenuItem>
          </MenuContent>
        </Menu>
      </PanelHeader>
      <div className={scrollArea}>
        <Brief />
        <SectionLabel right={<span className="text-2xs text-fg-4 tabular">{scenes.length ? `${done}/${scenes.length} done · ${secs(total)}` : ''}</span>}>Scenes</SectionLabel>
        <div className="space-y-2" onDragOver={(e) => drag && e.preventDefault()} onDrop={drop}>
          {scenes.map((scene, i) => (
            <div
              key={scene.id}
              onDragOver={(e) => {
                if (!drag || !e.dataTransfer.types.includes(SCENE_MIME)) return
                e.preventDefault()
                const r = e.currentTarget.getBoundingClientRect()
                const over = e.clientY < r.top + r.height / 2 ? i : i + 1
                if (over !== drag.over) setDrag({ ...drag, over })
              }}
              className="relative"
            >
              {drag && drag.over === i && drag.id !== scene.id && <DropLine top />}
              <SceneCard
                scene={scene}
                n={i}
                count={scenes.length}
                startsAt={starts[i]}
                dragging={drag?.id === scene.id}
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = 'move'
                  e.dataTransfer.setData(SCENE_MIME, scene.id)
                  const card = (e.currentTarget as HTMLElement).closest('[data-scene]')
                  if (card) e.dataTransfer.setDragImage(card, 16, 16)
                  setDrag({ id: scene.id, over: i })
                }}
                onDragEnd={() => setDrag(null)}
              />
              {drag && i === scenes.length - 1 && drag.over === scenes.length && <DropLine />}
            </div>
          ))}
        </div>
        <Button variant="ghost" size="sm" className="mt-2 w-full text-fg-3" onClick={() => addScene()}>
          <Plus /> Add scene
        </Button>
        <p className="mt-3 px-1 text-2xs leading-relaxed text-fg-4">
          Drag the handle to reorder. A scene linked to its clips follows them through edits — <b className="font-medium text-fg-3">Show</b> finds it on the timeline.
        </p>
      </div>
    </>
  )
}

function DropLine({ top }: { top?: boolean }) {
  return <div className={cn('pointer-events-none absolute inset-x-1 z-10 h-0.5 rounded-full bg-accent', top ? '-top-[5px]' : '-bottom-[5px]')} />
}

function EmptyStoryboard({ onAdd }: { onAdd: () => void }) {
  const [brief, setBrief] = useState('')
  const plan = () => {
    const text = brief.trim()
    if (text) dispatch('storyboard.update', { brief: text })
    askCopilot(
      `Plan this video as a storyboard before producing anything (use the video-director skill)${text ? `: ${text}` : ' — ask me what it’s for if you need to'}. Save the brief and a style with storyboard_update, add the scenes, then show me the plan to review.`,
    )
  }
  return (
    <>
      <PanelHeader title="Storyboard" />
      <div className={scrollArea}>
        <div className="mt-6 mb-4 px-2 text-center">
          <div className="mx-auto mb-3 grid size-10 place-items-center rounded-xl bg-white/[0.04] text-fg-3 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)] [&_svg]:size-[18px]">
            <Film />
          </div>
          <h3 className="text-sm font-semibold text-fg">Plan the video first</h3>
          <p className="mx-auto mt-1 max-w-[230px] text-xs leading-relaxed text-fg-3">Scenes in order — what’s said, what’s shown, how long — to review before anything is made.</p>
        </div>
        <textarea
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          rows={4}
          placeholder="What’s the video? A 45-second launch film for our app, upbeat, for Instagram…"
          className="w-full resize-none rounded-lg bg-white/[0.045] px-2.5 py-2 text-sm leading-relaxed text-fg shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)] outline-none placeholder:text-fg-4 focus:shadow-[inset_0_0_0_1px_rgb(214_238_0/0.5),0_0_0_3px_rgb(214_238_0/0.12)]"
        />
        <Button variant="ai" className="mt-2 w-full" onClick={plan}>
          <AiSparkle className="!size-3.5 [&_path]:fill-accent-fg" /> Plan with Copilot
        </Button>
        <Button variant="ghost" size="sm" className="mt-1.5 w-full text-fg-3" onClick={onAdd}>
          <Plus /> Add a scene yourself
        </Button>
      </div>
    </>
  )
}

/** The brief and the style every scene keeps. */
function Brief() {
  const brief = useEditor((s) => s.project.storyboard?.brief ?? '')
  const style = useEditor((s) => s.project.storyboard?.style ?? '')
  const brand = useEditor((s) => s.project.brand?.name)
  const [open, setOpen] = useState(!brief)
  const options = [
    { value: 'none', label: 'No style yet' },
    ...STYLES.map((s) => ({ value: s.id, label: s.name })),
    ...(brand ? [{ value: 'brand', label: `${brand} (brand)` }] : []),
    ...(style && style !== 'brand' && !styleById(style) ? [{ value: style, label: style }] : []),
  ]
  return (
    <div className="mt-1 rounded-[10px] bg-white/[0.025] px-3 py-2.5 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.05)]">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-1.5 text-left outline-none">
        <ChevronRight className={cn('size-3.5 shrink-0 text-fg-4 transition-transform duration-200', open && 'rotate-90')} />
        <span className="text-2xs font-semibold tracking-wider text-fg-4 uppercase">Brief</span>
        {!open && <span className="min-w-0 flex-1 truncate text-xs text-fg-3">{brief || 'What the video is for'}</span>}
      </button>
      {open && (
        <textarea
          value={brief}
          onChange={(e) => dispatch('storyboard.update', { brief: e.target.value }, { coalesce: 'storyboard:brief' })}
          rows={Math.min(6, Math.max(2, brief.split('\n').length + 1))}
          placeholder="Purpose, audience, tone, length, format"
          className="mt-2 w-full resize-none rounded-lg bg-white/[0.045] px-2.5 py-2 text-xs leading-relaxed text-fg shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)] outline-none placeholder:text-fg-4 focus:shadow-[inset_0_0_0_1px_rgb(214_238_0/0.5),0_0_0_3px_rgb(214_238_0/0.12)]"
        />
      )}
      <div className="mt-2 flex items-center gap-2">
        <span className="w-10 shrink-0 text-xs text-fg-3">Style</span>
        <Select aria-label="Style" value={style || 'none'} onChange={(v) => dispatch('storyboard.update', { style: v === 'none' ? null : v })} options={options} className="min-w-0 flex-1" />
      </div>
    </div>
  )
}

interface SceneCardProps {
  scene: StoryboardScene
  n: number
  count: number
  startsAt: number
  dragging: boolean
  onDragStart: (e: DragEvent) => void
  onDragEnd: () => void
}

function SceneCard({ scene, n, count, startsAt, dragging, onDragStart, onDragEnd }: SceneCardProps) {
  const [open, setOpen] = useState(false)
  // Just the numbers, so the card only re-renders when its stretch moves.
  const range = useEditor(
    useShallow((s) => {
      const r = sceneRange(s.project, scene)
      return r ? { from: r.from, to: r.to, fps: r.fps, open: r.open } : null
    }),
  )
  const timelineSelection = useUI((s) => s.selection)
  const set = (patch: ScenePatch, key?: string) => updateScene(scene.id, patch, key)
  const label = scene.title || `Scene ${n + 1}`

  const duplicate = () => {
    const { id: _id, produced: _produced, ...rest } = scene
    dispatch('storyboard.addScenes', { scenes: [{ ...rest, title: `${label} copy`, status: 'planned' }], index: n + 1 })
  }

  return (
    <div
      data-scene={scene.id}
      className={cn(
        'group/scene rounded-[10px] bg-white/[0.03] px-2.5 pt-2 pb-2.5 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)] transition-[opacity,box-shadow] duration-150 hover:shadow-[inset_0_0_0_1px_rgb(255_255_255/0.1)]',
        dragging && 'opacity-40',
      )}
    >
      <div className="flex items-center gap-1">
        <span
          draggable
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          aria-label="Drag to reorder"
          className="-ml-1 grid h-6 w-4 shrink-0 cursor-grab place-items-center text-fg-4 opacity-60 hover:text-fg-2 hover:opacity-100 active:cursor-grabbing"
        >
          <GripVertical className="size-3.5" />
        </span>
        <span className="shrink-0 font-mono text-2xs text-fg-4 tabular">{String(n + 1).padStart(2, '0')}</span>
        <input
          value={scene.title}
          onChange={(e) => set({ title: e.target.value }, 'title')}
          placeholder={`Scene ${n + 1}`}
          spellCheck={false}
          className="h-6 min-w-0 flex-1 rounded-md bg-transparent px-1 text-sm font-medium text-fg outline-none placeholder:text-fg-4 hover:bg-white/[0.04] focus:bg-white/[0.06]"
        />
        <Tip content="Click to change">
          <button type="button" onClick={() => set({ status: NEXT_STATUS[scene.status] })} className={cn('h-5 shrink-0 rounded-full px-1.5 text-[10px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-accent/60', STATUS_STYLE[scene.status])}>
            {SCENE_STATUSES.find((s) => s.id === scene.status)?.name}
          </button>
        </Tip>
        <Menu>
          <MenuTrigger asChild>
            <IconButton label="Scene" size="xs" className="opacity-60 group-hover/scene:opacity-100">
              <Ellipsis />
            </IconButton>
          </MenuTrigger>
          <MenuContent align="end">
            <MenuItem icon={<ArrowUp />} disabled={n === 0} onSelect={() => dispatch('storyboard.moveScene', { id: scene.id, index: n - 1 })}>
              Move up
            </MenuItem>
            <MenuItem icon={<ArrowDown />} disabled={n === count - 1} onSelect={() => dispatch('storyboard.moveScene', { id: scene.id, index: n + 1 })}>
              Move down
            </MenuItem>
            <MenuItem icon={<Plus />} onSelect={() => dispatch('storyboard.addScenes', { scenes: [{ title: `Scene ${count + 1}` }], index: n + 1 })}>
              Add a scene after
            </MenuItem>
            <MenuItem icon={<Copy />} onSelect={duplicate}>
              Duplicate
            </MenuItem>
            {scene.produced && (
              <MenuItem icon={<Unlink />} onSelect={() => set({ produced: null })}>
                Unlink from the timeline
              </MenuItem>
            )}
            <MenuSeparator />
            <MenuItem icon={<Trash />} danger onSelect={() => dispatch('storyboard.removeScenes', { ids: [scene.id] })}>
              Remove scene
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>

      <div className="mt-1.5 flex items-center gap-1.5">
        <Select<SceneTreatment>
          aria-label="Treatment"
          value={scene.treatment}
          onChange={(treatment) => set({ treatment })}
          options={SCENE_TREATMENTS.map((t) => ({ value: t.id, label: <TreatmentLabel id={t.id} name={t.name} /> }))}
          className="min-w-0 flex-1"
        />
        <ScrubInput aria-label="Target length" value={scene.seconds} onChange={(seconds) => set({ seconds: Math.round(seconds * 10) / 10 }, 'seconds')} min={0.5} max={600} step={0.5} sensitivity={0.1} precision={1} unit="s" className="w-[58px] shrink-0" />
      </div>
      <div className="mt-1 flex items-center justify-between px-0.5 text-2xs text-fg-4 tabular">
        <span>
          at {formatSeconds(startsAt)} · {scene.transition ? `${TRANSITIONS.find((t) => t.kind === scene.transition!.kind)?.name ?? scene.transition.kind} in` : 'cut in'}
        </span>
        <span>ends {formatSeconds(startsAt + scene.seconds)}</span>
      </div>

      <textarea
        value={scene.script}
        onChange={(e) => set({ script: e.target.value }, 'script')}
        rows={Math.min(6, Math.max(2, Math.ceil(scene.script.length / 34) + scene.script.split('\n').length - 1))}
        placeholder="What’s said — or the words on screen"
        className="mt-1.5 w-full resize-none rounded-lg bg-white/[0.035] px-2 py-1.5 text-xs leading-relaxed text-fg shadow-[inset_0_0_0_1px_rgb(255_255_255/0.05)] outline-none placeholder:text-fg-4 focus:shadow-[inset_0_0_0_1px_rgb(214_238_0/0.5),0_0_0_3px_rgb(214_238_0/0.12)]"
      />

      <button type="button" onClick={() => setOpen((o) => !o)} className="mt-1 flex w-full items-center gap-1 rounded-md px-0.5 py-0.5 text-left text-2xs text-fg-4 outline-none hover:text-fg-3">
        <ChevronRight className={cn('size-3 transition-transform duration-200', open && 'rotate-90')} />
        <span className="truncate">
          {[scene.assetIds.length ? `${scene.assetIds.length} media` : null, scene.needs.length ? `${scene.needs.length} needed` : null, scene.notes ? 'notes' : null].filter(Boolean).join(' · ') || 'Media, needs, transition, notes'}
        </span>
      </button>
      {open && <SceneDetails scene={scene} />}

      <div className="mt-1.5 flex items-center gap-1.5 border-t border-line pt-2">
        {range ? (
          <>
            <span className="min-w-0 flex-1 truncate text-2xs text-fg-3 tabular" title={range.open ? undefined : 'On another timeline'}>
              <span className="text-ok">●</span> {formatSeconds(range.from / range.fps)}–{formatSeconds(range.to / range.fps)}
              <span className="text-fg-4"> · {secs((range.to - range.from) / range.fps)}</span>
            </span>
            <Button size="xs" variant="ghost" onClick={() => showOnTimeline(scene)}>
              <LocateFixed /> Show
            </Button>
            <Tip content="Ask the Copilot to change this scene only">
              <Button size="xs" variant="ghost" onClick={() => askCopilot(`Revise scene ${n + 1} of the storyboard (“${label}”) — change only its clips and keep the rest of the edit as it is: `, false)}>
                <AiSparkle className="!size-3" /> Revise
              </Button>
            </Tip>
          </>
        ) : (
          <>
            <Tip content={timelineSelection.length ? 'Link the clips selected on the timeline to this scene' : 'Select the clips that make this scene on the timeline first'}>
              <Button size="xs" variant="ghost" disabled={!timelineSelection.length} onClick={() => set({ produced: { clipIds: timelineSelection } })}>
                <Link2 /> Link selection
              </Button>
            </Tip>
            <span className="flex-1" />
            <Button size="xs" variant="ghost" onClick={() => askCopilot(`Produce scene ${n + 1} of the storyboard (“${label}”) using the video-director skill: in the storyboard’s style, and link its clips to the scene when it’s done.`)}>
              <AiSparkle className="!size-3" /> Produce
            </Button>
          </>
        )}
      </div>
    </div>
  )
}

function TreatmentLabel({ id, name }: { id: SceneTreatment; name: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 [&_svg]:size-3.5 [&_svg]:text-fg-3">
      {TREATMENT_ICON[id]}
      {name}
    </span>
  )
}

/** Linked media (and finding more by the script), what's still needed, the transition in, and notes. */
function SceneDetails({ scene }: { scene: StoryboardScene }) {
  const assets = useEditor((s) => s.project.assets)
  const media = scene.assetIds.map((id) => assets[id]).filter(Boolean)
  const [need, setNeed] = useState('')
  const set = (patch: ScenePatch, key?: string) => updateScene(scene.id, patch, key)
  const addNeed = () => {
    const text = need.trim()
    if (!text) return
    set({ needs: [...scene.needs, text] })
    setNeed('')
  }
  const transitionOptions: { value: TransitionKind | 'cut'; label: string }[] = [{ value: 'cut', label: 'Straight cut' }, ...TRANSITIONS.map((t) => ({ value: t.kind, label: t.name }))]

  return (
    <div className="mt-1 space-y-2.5 rounded-lg bg-black/15 px-2 py-2">
      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="text-2xs font-medium text-fg-4">Media</span>
          <FindMedia scene={scene} />
        </div>
        {media.length ? (
          <div className="flex flex-wrap gap-1.5">
            {media.map((a) => (
              <Tip key={a.id} content={a.name}>
                <div className="group/m relative h-9 w-14 overflow-hidden rounded-md bg-black shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)]">
                  {assetThumb(a) ? <img src={assetThumb(a)} alt="" draggable={false} className="h-full w-full object-cover" /> : <span className="grid h-full place-items-center text-[9px] text-fg-4">{a.kind}</span>}
                  <button
                    type="button"
                    aria-label={`Unlink ${a.name}`}
                    onClick={() => set({ assetIds: scene.assetIds.filter((id) => id !== a.id) })}
                    className="absolute top-0.5 right-0.5 grid size-4 place-items-center rounded-full bg-black/70 text-white opacity-0 group-hover/m:opacity-100"
                  >
                    <X className="size-2.5" />
                  </button>
                </div>
              </Tip>
            ))}
          </div>
        ) : (
          <p className="text-2xs text-fg-4">None linked yet.</p>
        )}
      </div>

      <div>
        <span className="mb-1 block text-2xs font-medium text-fg-4">Still needed</span>
        {scene.needs.length > 0 && (
          <div className="mb-1.5 flex flex-wrap gap-1">
            {scene.needs.map((n, i) => (
              <span key={i} className="inline-flex max-w-full items-center gap-1 rounded-full bg-white/[0.06] py-0.5 pr-1 pl-2 text-2xs text-fg-2">
                <span className="truncate">{n}</span>
                <button type="button" aria-label="Remove" onClick={() => set({ needs: scene.needs.filter((_, j) => j !== i) })} className="grid size-3.5 place-items-center rounded-full text-fg-4 hover:bg-white/10 hover:text-fg">
                  <X className="size-2.5" />
                </button>
              </span>
            ))}
          </div>
        )}
        <input
          value={need}
          onChange={(e) => setNeed(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addNeed()}
          onBlur={addNeed}
          placeholder="A shot to find, media to generate… ↵"
          spellCheck={false}
          className="h-6 w-full rounded-md bg-white/[0.04] px-2 text-2xs text-fg outline-none placeholder:text-fg-4 focus:bg-white/[0.06]"
        />
      </div>

      <div className="flex items-center gap-1.5">
        <span className="w-14 shrink-0 text-2xs font-medium text-fg-4">Comes in</span>
        <Select<TransitionKind | 'cut'>
          aria-label="Transition in"
          value={scene.transition?.kind ?? 'cut'}
          onChange={(kind) => set({ transition: kind === 'cut' ? null : { kind, seconds: scene.transition?.seconds ?? 0.6 } })}
          options={transitionOptions}
          className="min-w-0 flex-1"
        />
        {scene.transition && (
          <ScrubInput aria-label="Transition length" value={scene.transition.seconds} onChange={(seconds) => set({ transition: { kind: scene.transition!.kind, seconds: Math.round(seconds * 100) / 100 } }, 'transition')} min={0.1} max={4} step={0.1} sensitivity={0.02} precision={1} unit="s" className="w-[54px] shrink-0" />
        )}
      </div>

      <textarea
        value={scene.notes}
        onChange={(e) => set({ notes: e.target.value }, 'notes')}
        rows={2}
        placeholder="Notes: shot ideas, music cue, what to avoid"
        className="w-full resize-none rounded-md bg-white/[0.04] px-2 py-1.5 text-2xs leading-relaxed text-fg outline-none placeholder:text-fg-4 focus:bg-white/[0.06]"
      />
    </div>
  )
}

/** Media in the project that fits the scene's script, best first — one click links it. */
function FindMedia({ scene }: { scene: StoryboardScene }) {
  const [open, setOpen] = useState(false)
  const assets = useEditor((s) => s.project.assets)
  const found = useMemo(() => {
    if (!open || !scene.script.trim()) return null
    const r = rankBroll(getProject(), scriptSentences(scene.script), { perLine: 4 })
    // Best score per media item across the script's sentences.
    const best = new Map<string, BrollCandidate>()
    for (const s of r.suggestions) for (const c of s.candidates) if ((best.get(c.assetId)?.score ?? 0) < c.score) best.set(c.assetId, c)
    return { candidates: [...best.values()].sort((a, b) => b.score - a.score).slice(0, 8), undescribed: r.undescribed.length, considered: r.considered }
    // `assets` keeps it fresh when media is added or described while it's open.
  }, [open, scene.script, assets])

  const link = (id: string) => {
    if (!scene.assetIds.includes(id)) updateScene(scene.id, { assetIds: [...scene.assetIds, id] })
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="flex items-center gap-1 rounded-md px-1 text-2xs text-fg-3 outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/60">
          <Search className="size-3" /> Find media
        </button>
      </PopoverTrigger>
      <PopoverContent side="right" align="start" className="w-72 p-2">
        <div className="mb-1.5 px-1 text-2xs font-semibold tracking-wider text-fg-4 uppercase">Fits the script</div>
        {!scene.script.trim() ? (
          <p className="px-1 py-2 text-xs text-fg-3">Write the script first — media is matched to its words.</p>
        ) : !found?.candidates.length ? (
          <p className="px-1 py-2 text-xs leading-relaxed text-fg-3">
            {found?.considered ? 'Nothing in the project fits these words yet.' : 'There’s no video or still in the project yet.'}
            {found?.undescribed ? ` ${found.undescribed} media item${found.undescribed === 1 ? ' has' : 's have'} nothing to go on — ask the Copilot to look at and describe them.` : ''}
          </p>
        ) : (
          <div className="max-h-72 space-y-0.5 overflow-y-auto">
            {found.candidates.map((c) => {
              const asset = assets[c.assetId]
              const linked = scene.assetIds.includes(c.assetId)
              return (
                <button
                  key={c.assetId}
                  type="button"
                  disabled={linked}
                  onClick={() => link(c.assetId)}
                  className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left outline-none hover:bg-white/[0.06] disabled:opacity-60"
                >
                  <span className="h-8 w-12 shrink-0 overflow-hidden rounded bg-black shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)]">
                    {asset && assetThumb(asset) && <img src={assetThumb(asset)} alt="" draggable={false} className="h-full w-full object-cover" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs text-fg-2">{c.name}</span>
                    <span className="block truncate text-2xs text-fg-4">{c.matched.join(', ')}</span>
                  </span>
                  <span className="flex w-9 shrink-0 flex-col items-end gap-0.5">
                    {linked ? (
                      <span className="text-2xs text-accent-2">Linked</span>
                    ) : (
                      <>
                        <span className="text-2xs text-fg-3 tabular">{Math.round(c.score * 100)}</span>
                        <span className="h-0.5 w-8 overflow-hidden rounded-full bg-white/10">
                          <span className="block h-full rounded-full bg-accent" style={{ width: `${c.score * 100}%` }} />
                        </span>
                      </>
                    )}
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
