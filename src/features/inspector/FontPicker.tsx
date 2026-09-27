/**
 * Font picker: the built-in typefaces, fonts already in the project, and a way
 * to add more — from the fonts installed on this computer or from a font file.
 * Added fonts are embedded in the project, so it opens the same anywhere.
 */
import { ChevronDown, FileUp, HardDrive, LoaderCircle, Search } from 'lucide-react'
import { parse } from 'opentype.js'
import { useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { FONTS } from '@/editor/defaults'
import { uid } from '@/lib/id'
import { dispatch, getProject, useEditor } from '@/editor/store'
import type { FontId, FontRef } from '@/editor/types'
import { bytesToBase64, fontCss, fontLabel, localFonts, registerProjectFonts, uniqueFamily, type LocalFont } from '@/engine/fonts'
import { cn } from '@/lib/cn'

/** Embeds a font file in the project and returns its reference. */
async function embedFont(bytes: Uint8Array, fallbackName: string, fileName: string): Promise<FontRef | null> {
  let name = fallbackName
  try {
    const f = parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
    name = f.names.fullName?.en ?? f.names.fontFamily?.en ?? fallbackName
  } catch {
    // Not every font parses in opentype.js (WOFF2, some CFF); the page can still use it.
  }
  const existing = Object.values(getProject().fonts ?? {}).find((f) => f.name === name)
  if (existing) return `custom:${existing.id}`
  const id = uid('font')
  const res = dispatch('font.add', { font: { id, name, family: uniqueFamily(name, id), fileName, data: bytesToBase64(bytes) } })
  if (!res.ok) {
    toast.error('Couldn’t add the font', { description: res.error })
    return null
  }
  registerProjectFonts(getProject())
  return `custom:${id}`
}

export function FontPicker({ value, onChange }: { value: FontRef; onChange: (font: FontRef) => void }) {
  const projectFonts = useEditor((s) => s.project.fonts)
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<'list' | 'system'>('list')
  const [system, setSystem] = useState<LocalFont[] | null | 'loading'>(null)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const file = useRef<HTMLInputElement>(null)
  const project = { fonts: projectFonts }

  const pick = (font: FontRef) => {
    onChange(font)
    setOpen(false)
  }

  const showSystem = async () => {
    setView('system')
    if (system && system !== 'loading') return
    setSystem('loading')
    const list = await localFonts()
    setSystem(list)
  }

  const families = useMemo(() => {
    if (!Array.isArray(system)) return []
    const q = query.trim().toLowerCase()
    return system.filter((f) => !q || f.fullName.toLowerCase().includes(q)).slice(0, 300)
  }, [system, query])

  const addSystem = async (f: LocalFont) => {
    setBusy(f.postscriptName)
    try {
      const blob = await f.load()
      const ref = await embedFont(new Uint8Array(await blob.arrayBuffer()), f.fullName, `${f.postscriptName}.ttf`)
      if (ref) pick(ref)
    } catch (err) {
      toast.error('Couldn’t read that font', { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(null)
    }
  }

  const addFile = async (list: FileList | null) => {
    const f = list?.[0]
    if (!f) return
    const ref = await embedFont(new Uint8Array(await f.arrayBuffer()), f.name.replace(/\.[^.]+$/, ''), f.name)
    if (ref) pick(ref)
  }

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (o) setView('list')
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex h-8 w-full min-w-0 items-center gap-2 rounded-control bg-white/[0.045] px-2.5 text-left text-sm text-fg shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)] outline-none hover:bg-white/[0.07] focus-visible:ring-2 focus-visible:ring-accent/60"
        >
          <span className="min-w-0 flex-1 truncate" style={{ fontFamily: fontCss(value, project) }}>
            {fontLabel(value, project)}
          </span>
          <ChevronDown className="size-3.5 shrink-0 text-fg-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="start" className="w-72 p-1.5">
        {view === 'list' ? (
          <div className="max-h-80 overflow-y-auto">
            <Heading>Built in</Heading>
            {(Object.keys(FONTS) as FontId[]).map((f) => (
              <Item key={f} active={value === f} onClick={() => pick(f)} family={FONTS[f].css}>
                {FONTS[f].label}
              </Item>
            ))}
            {Object.values(projectFonts ?? {}).length > 0 && <Heading>In this project</Heading>}
            {Object.values(projectFonts ?? {}).map((f) => (
              <Item key={f.id} active={value === `custom:${f.id}`} onClick={() => pick(`custom:${f.id}`)} family={fontCss(`custom:${f.id}`, project)}>
                {f.name}
              </Item>
            ))}
            <div className="mx-1 my-1.5 h-px bg-line" />
            <button type="button" onClick={() => void showSystem()} className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm text-fg-2 hover:bg-white/[0.06] hover:text-fg">
              <HardDrive className="size-4 text-fg-3" /> Fonts on this computer…
            </button>
            <button type="button" onClick={() => file.current?.click()} className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm text-fg-2 hover:bg-white/[0.06] hover:text-fg">
              <FileUp className="size-4 text-fg-3" /> Import a font file…
            </button>
            <input ref={file} type="file" accept=".ttf,.otf,.woff,.woff2,font/*" className="hidden" onChange={(e) => void addFile(e.target.files).finally(() => (e.target.value = ''))} />
          </div>
        ) : (
          <div>
            <div className="mb-1.5 flex items-center gap-1.5 rounded-md bg-white/[0.05] px-2">
              <Search className="size-3.5 text-fg-4" />
              <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.stopPropagation()} placeholder="Search fonts" className="h-8 min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-fg-4" />
            </div>
            <div className="max-h-72 overflow-y-auto">
              {system === 'loading' && (
                <p className="flex items-center gap-2 px-2 py-4 text-sm text-fg-3">
                  <LoaderCircle className="size-4 animate-spin" /> Reading your fonts…
                </p>
              )}
              {system === null && <p className="px-2 py-4 text-sm text-fg-3">This browser can’t list installed fonts — import a font file instead.</p>}
              {families.map((f) => (
                <button
                  key={f.postscriptName}
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void addSystem(f)}
                  className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-fg-2 hover:bg-white/[0.06] hover:text-fg disabled:opacity-50"
                >
                  <span className="min-w-0 flex-1 truncate" style={{ fontFamily: `"${f.family}"` }}>
                    {f.fullName}
                  </span>
                  {busy === f.postscriptName && <LoaderCircle className="size-3.5 animate-spin" />}
                </button>
              ))}
            </div>
            <button type="button" onClick={() => setView('list')} className="mt-1 h-7 w-full rounded-md text-xs text-fg-3 hover:bg-white/[0.05] hover:text-fg">
              Back
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

function Heading({ children }: { children: string }) {
  return <div className="px-2 pt-1.5 pb-1 text-2xs font-semibold tracking-wider text-fg-4 uppercase">{children}</div>
}

function Item({ active, onClick, family, children }: { active: boolean; onClick: () => void; family: string; children: string }) {
  return (
    <button type="button" onClick={onClick} className={cn('flex h-8 w-full items-center rounded-md px-2 text-left text-[15px] text-fg-2 hover:bg-white/[0.06] hover:text-fg', active && 'bg-accent/12 text-accent-2')} style={{ fontFamily: family }}>
      <span className="truncate">{children}</span>
    </button>
  )
}
