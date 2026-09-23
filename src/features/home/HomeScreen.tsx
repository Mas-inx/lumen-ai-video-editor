import { ArrowLeft, Clock, FilePlus2, FolderOpen, History, Trash2, TriangleAlert, Upload, X } from 'lucide-react'
import { motion } from 'motion/react'
import { useState, type DragEvent } from 'react'
import { LogoMark } from '@/components/brand'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { Segmented } from '@/components/ui/segmented'
import { Tip } from '@/components/ui/tooltip'
import { CANVAS_PRESETS, FRAME_RATES, type CanvasPreset } from '@/editor/new-project'
import { useEditor } from '@/editor/store'
import { cn } from '@/lib/cn'
import { APP_VERSION, desktop } from '@/lib/platform'
import { importDropped } from '@/project/media-import'
import { discardRecovery, forgetRecent, newProject, openProject, recover, showHome, useSession } from '@/project/session'

function timeAgo(ms: number) {
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  const d = Math.floor(s / 86400)
  if (d < 7) return d === 1 ? 'yesterday' : `${d} days ago`
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

const folderOf = (p: string) => p.replace(/[\\/][^\\/]*$/, '')

function PresetShape({ preset, active }: { preset: CanvasPreset; active: boolean }) {
  const ratio = preset.width / preset.height
  const max = 34
  const w = ratio >= 1 ? max : Math.round(max * ratio)
  const h = ratio >= 1 ? Math.round(max / ratio) : max
  return (
    <span className="grid size-10 shrink-0 place-items-center">
      <span
        className={cn('rounded-[4px] transition-colors', active ? 'bg-accent/20 shadow-[inset_0_0_0_1.5px_var(--color-accent)]' : 'bg-white/[0.04] shadow-[inset_0_0_0_1.5px_rgb(255_255_255/0.25)]')}
        style={{ width: w, height: h }}
      />
    </span>
  )
}

export function HomeScreen() {
  const recent = useSession((s) => s.recent)
  const recovery = useSession((s) => s.recovery)
  const busy = useSession((s) => s.busy)
  const hasProject = useSession((s) => s.hasProject)
  const currentName = useEditor((s) => s.project.name)
  const [preset, setPreset] = useState(CANVAS_PRESETS[0].id)
  const [fps, setFps] = useState('30')
  const [dragging, setDragging] = useState(false)

  const chosen = CANVAS_PRESETS.find((p) => p.id === preset)!
  const create = (p: CanvasPreset = chosen) => void newProject({ width: p.width, height: p.height, fps: Number(fps) })

  const onDrop = async (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const files = [...e.dataTransfer.files]
    if (!files.length) return
    const lumen = files.find((f) => f.name.toLowerCase().endsWith('.lumen'))
    if (lumen && desktop) return void openProject(desktop.files.pathForFile(lumen))
    if (await newProject({ width: chosen.width, height: chosen.height, fps: Number(fps) })) await importDropped(files)
  }

  return (
    <div
      className="relative flex min-h-0 flex-1 overflow-hidden px-2 pb-2"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          setDragging(true)
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false)
      }}
      onDrop={(e) => void onDrop(e)}
    >
      <div className="panel relative flex min-h-0 flex-1 overflow-hidden">
        {/* Left: start something */}
        <motion.section
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
          className="flex w-[min(560px,48%)] shrink-0 flex-col overflow-y-auto border-r border-line px-10 py-10"
        >
          <div className="flex items-center gap-3">
            <LogoMark className="size-11 drop-shadow-[0_6px_24px_rgb(214_238_0/0.28)]" />
            <div>
              <h1 className="font-display text-2xl leading-none font-semibold tracking-tight text-fg">Lumen</h1>
              <p className="mt-1 text-xs text-fg-4">AI-native video editor · v{APP_VERSION}</p>
            </div>
          </div>

          {hasProject && (
            <button
              type="button"
              onClick={() => showHome(false)}
              className="mt-8 flex items-center gap-2 self-start rounded-lg px-2 py-1.5 text-sm text-fg-3 transition-colors hover:bg-white/[0.05] hover:text-fg"
            >
              <ArrowLeft className="size-4" /> Back to {currentName}
            </button>
          )}

          <h2 className={cn('text-md font-semibold text-fg', hasProject ? 'mt-6' : 'mt-10')}>New project</h2>
          <p className="mt-1 text-xs text-fg-4">Pick a canvas. You can change it any time in Project settings.</p>
          <div className="mt-4 grid grid-cols-2 gap-2">
            {CANVAS_PRESETS.map((p) => {
              const active = p.id === preset
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setPreset(p.id)}
                  onDoubleClick={() => create(p)}
                  className={cn(
                    'flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-left outline-none transition-[background-color,box-shadow] focus-visible:ring-2 focus-visible:ring-accent/60',
                    active ? 'bg-accent/[0.08] shadow-[inset_0_0_0_1px_rgb(214_238_0/0.45)]' : 'bg-white/[0.025] shadow-[inset_0_0_0_1px_rgb(255_255_255/0.05)] hover:bg-white/[0.05]',
                  )}
                >
                  <PresetShape preset={p} active={active} />
                  <span className="min-w-0">
                    <span className={cn('block text-sm font-medium', active ? 'text-fg' : 'text-fg-2')}>{p.label}</span>
                    <span className="block truncate text-2xs text-fg-4">{p.hint}</span>
                  </span>
                </button>
              )
            })}
          </div>
          <div className="mt-4 flex items-center justify-between gap-3">
            <span className="text-xs text-fg-3">Frame rate</span>
            <Segmented value={fps} onChange={setFps} options={FRAME_RATES.map((f) => ({ value: String(f), label: `${f}` }))} />
          </div>
          <div className="mt-6 flex gap-2">
            <Button variant="primary" size="lg" className="flex-1" onClick={() => create()} disabled={busy}>
              <FilePlus2 />
              Create {chosen.width}×{chosen.height}
            </Button>
            <Button variant="secondary" size="lg" onClick={() => void openProject()} disabled={busy || !desktop}>
              <FolderOpen />
              Open…
            </Button>
          </div>
          <div className="mt-auto flex items-center gap-2 pt-10 text-2xs text-fg-4">
            <Upload className="size-3.5" /> Drop video, audio or images here to start a project with them · <Kbd combo="mod+o" /> open
          </div>
        </motion.section>

        {/* Right: continue something */}
        <motion.section
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, delay: 0.05, ease: [0.16, 1, 0.3, 1] }}
          className="flex min-w-0 flex-1 flex-col overflow-y-auto px-10 py-10"
        >
          {recovery && (
            <div className="mb-8 flex items-start gap-3 rounded-xl bg-warn/[0.07] p-4 shadow-[inset_0_0_0_1px_rgb(245_183_59/0.25)]">
              <History className="mt-0.5 size-5 shrink-0 text-warn" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-fg">Unsaved changes to “{recovery.name}”</div>
                <div className="mt-0.5 text-xs text-fg-3">
                  Lumen closed before they were saved · {timeAgo(recovery.savedAt)}
                  {recovery.path ? ` · ${recovery.path}` : ''}
                </div>
                <div className="mt-3 flex gap-2">
                  <Button variant="primary" size="sm" onClick={() => void recover()}>
                    Recover
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => void discardRecovery()}>
                    Discard
                  </Button>
                </div>
              </div>
            </div>
          )}

          <div className="flex items-center gap-2">
            <Clock className="size-4 text-fg-4" />
            <h2 className="text-md font-semibold text-fg">Recent projects</h2>
          </div>
          {recent.length === 0 ? (
            <div className="mt-6 grid flex-1 place-items-center rounded-2xl border border-dashed border-line-2 px-8 py-16 text-center">
              <div>
                <FolderOpen className="mx-auto size-8 text-fg-4" />
                <p className="mt-3 text-sm text-fg-3">Projects you save will show up here.</p>
                <p className="mt-1 text-xs text-fg-4">Lumen projects are .lumen files — keep them next to your media.</p>
              </div>
            </div>
          ) : (
            <ul className="mt-4 space-y-1.5">
              {recent.map((r) => (
                <li key={r.path}>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => r.exists && void openProject(r.path)}
                    onKeyDown={(e) => e.key === 'Enter' && r.exists && void openProject(r.path)}
                    className={cn(
                      'group flex items-center gap-3 rounded-xl px-3 py-2.5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/60',
                      r.exists ? 'cursor-default bg-white/[0.025] hover:bg-white/[0.06]' : 'bg-white/[0.015] opacity-60',
                    )}
                  >
                    <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent/10 text-accent-2">
                      {r.exists ? <LogoMark className="size-5 opacity-90" /> : <TriangleAlert className="size-4 text-warn" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-fg">{r.name}</span>
                      <span className="block truncate text-2xs text-fg-4">{r.exists ? folderOf(r.path) : `Not found · ${r.path}`}</span>
                    </span>
                    <span className="shrink-0 text-2xs text-fg-4 tabular">{timeAgo(r.openedAt)}</span>
                    <Tip content={r.exists ? 'Remove from list' : 'Remove'}>
                      <button
                        type="button"
                        aria-label="Remove from recent projects"
                        onClick={(e) => {
                          e.stopPropagation()
                          void forgetRecent(r.path)
                        }}
                        className="grid size-7 shrink-0 place-items-center rounded-md text-fg-4 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-white/[0.08] hover:text-fg-2 focus-visible:opacity-100"
                      >
                        {r.exists ? <X className="size-3.5" /> : <Trash2 className="size-3.5" />}
                      </button>
                    </Tip>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </motion.section>

        {dragging && (
          <div className="pointer-events-none absolute inset-3 grid place-items-center rounded-2xl border-2 border-dashed border-accent/70 bg-accent/[0.06] backdrop-blur-[2px]">
            <div className="text-center">
              <Upload className="mx-auto size-8 text-accent" />
              <p className="mt-2 text-sm font-medium text-fg">Drop to start a {chosen.label.toLowerCase()} project with these files</p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
