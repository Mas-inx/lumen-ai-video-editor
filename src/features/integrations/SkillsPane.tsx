import { BookOpen, Eye, FolderOpen, Import, LoaderCircle, Pencil, Plus, Trash } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import type { SkillDoc, SkillSource } from '@shared/skills'
import { Button, IconButton } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Markdown } from '@/features/copilot/Markdown'
import { loadSkill, refreshSkills, setSkillEnabled, skillEntries, useSkills, type SkillEntry } from '@/integrations/skills'
import { api } from '@/integrations/store'
import { IconTile } from './parts'

function Header({ icon, title, subtitle, right }: { icon: ReactNode; title: string; subtitle: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-6 flex items-start gap-4">
      {icon}
      <div className="min-w-0 flex-1">
        <h2 className="text-xl font-semibold tracking-tight text-fg">{title}</h2>
        <p className="mt-0.5 text-sm leading-relaxed text-fg-3">{subtitle}</p>
      </div>
      {right}
    </div>
  )
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '')

/** Skills: Lumen's own, yours and Claude Code's — what the Copilot knows how to do well. */
export function SkillsPane() {
  const disk = useSkills((s) => s.disk)
  const off = useSkills((s) => s.off)
  const on = useSkills((s) => s.on)
  const loaded = useSkills((s) => s.loaded)
  const [viewing, setViewing] = useState<SkillEntry | null>(null)
  const [editing, setEditing] = useState<{ folder?: string } | null>(null)
  const entries = skillEntries({ disk, off, on })
  const builtin = entries.filter((k) => k.source === 'builtin')
  const yours = entries.filter((k) => k.source === 'user')
  const claude = entries.filter((k) => k.source === 'claude')

  useEffect(() => {
    void refreshSkills()
  }, [])

  const importFolder = async () => {
    try {
      const skill = await api?.skills.import()
      if (skill) {
        toast.success(`Added the “${skill.name}” skill`)
        await refreshSkills()
      }
    } catch (err) {
      toast.error('Couldn’t import that skill', { description: errorText(err) })
    }
  }

  return (
    <div>
      <Header
        icon={
          <IconTile tone="lumen">
            <BookOpen />
          </IconTile>
        }
        title="Skills"
        subtitle="Know-how the Copilot loads when a task calls for it — craft rules for motion design, 3D, grading, sound and more, plus your own. The same SKILL.md format as Claude, so they work for Claude Code and any agent using Lumen’s MCP server too."
      />
      <div className="mb-6 flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" onClick={() => setEditing({})}>
          <Plus /> New skill
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void importFolder()}>
          <Import /> Import a skill folder…
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void api?.skills.openFolder()}>
          <FolderOpen /> Open your skills folder
        </Button>
      </div>

      <Section title="Built in" count={builtin.length}>
        {builtin.map((k) => (
          <SkillRow key={k.key} skill={k} onView={() => setViewing(k)} />
        ))}
      </Section>

      <Section title="Yours" count={yours.length}>
        {yours.map((k) => (
          <SkillRow key={k.key} skill={k} onView={() => setViewing(k)} onEdit={() => setEditing({ folder: k.folder })} />
        ))}
        {loaded && !yours.length && (
          <p className="rounded-xl border border-dashed border-line-2 px-4 py-5 text-xs leading-relaxed text-fg-4">
            Write down how you like things done — your brand’s fonts and colours, your channel’s pacing, how captions should look — and the Copilot follows it whenever it applies.
          </p>
        )}
      </Section>

      {claude.length > 0 && (
        <Section title="From Claude Code" hint="~/.claude/skills — off until you switch them on" count={claude.length}>
          {claude.map((k) => (
            <SkillRow key={k.key} skill={k} onView={() => setViewing(k)} />
          ))}
        </Section>
      )}

      <SkillViewer skill={viewing} onClose={() => setViewing(null)} />
      {editing && <SkillEditor folder={editing.folder} onClose={() => setEditing(null)} />}
    </div>
  )
}

function Section({ title, hint, count, children }: { title: string; hint?: string; count: number; children: ReactNode }) {
  return (
    <div className="mb-6">
      <div className="mb-2 flex items-baseline gap-2">
        <h3 className="text-2xs font-semibold tracking-wider text-fg-4 uppercase">{title}</h3>
        <span className="text-2xs text-fg-4 tabular">{count}</span>
        {hint && <span className="text-2xs text-fg-4">· {hint}</span>}
      </div>
      <div className="space-y-1.5">{children}</div>
    </div>
  )
}

function SkillRow({ skill, onView, onEdit }: { skill: SkillEntry; onView: () => void; onEdit?: () => void }) {
  const remove = async () => {
    if (!api) return
    try {
      await api.skills.delete(skill.folder)
      await refreshSkills()
      toast.success(`Deleted the “${skill.name}” skill`)
    } catch (err) {
      toast.error('Couldn’t delete it', { description: errorText(err) })
    }
  }
  return (
    <div className="group/skill flex items-start gap-3 rounded-xl bg-white/[0.025] px-3.5 py-3 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.05)]">
      <div className="min-w-0 flex-1">
        <div className="font-mono text-[12px] text-fg">{skill.name}</div>
        <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-fg-3">{skill.description}</p>
        {skill.files.length > 0 && <p className="mt-1 text-2xs text-fg-4">+ {skill.files.length} file{skill.files.length === 1 ? '' : 's'}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <IconButton size="xs" label="Read it" onClick={onView}>
          <Eye />
        </IconButton>
        {onEdit && (
          <>
            <IconButton size="xs" label="Edit" onClick={onEdit}>
              <Pencil />
            </IconButton>
            <IconButton size="xs" label="Delete" onClick={() => void remove()} className="hover:text-danger">
              <Trash />
            </IconButton>
          </>
        )}
        <Switch className="ml-1.5" checked={skill.enabled} onChange={(v) => setSkillEnabled(skill.key, v)} aria-label={skill.enabled ? `Switch off ${skill.name}` : `Switch on ${skill.name}`} />
      </div>
    </div>
  )
}

function SkillViewer({ skill, onClose }: { skill: SkillEntry | null; onClose: () => void }) {
  const [doc, setDoc] = useState<SkillDoc | null>(null)
  useEffect(() => {
    setDoc(null)
    if (skill)
      void loadSkill(skill)
        .then(setDoc)
        .catch((err) => toast.error('Couldn’t read that skill', { description: errorText(err) }))
  }, [skill])
  return (
    <Dialog open={Boolean(skill)} onOpenChange={(o) => !o && onClose()} title={skill?.name} description={skill?.description} className="w-[min(760px,calc(100vw-32px))]">
      <div className="max-h-[62vh] overflow-y-auto px-5 pb-5 text-sm leading-relaxed text-fg-2">
        {doc ? <Markdown text={doc.body} /> : <LoaderCircle className="mx-auto my-8 size-5 animate-spin text-fg-4" />}
        {doc && doc.files.length > 0 && (
          <div className="mt-4 border-t border-line pt-3 text-xs text-fg-4">
            Files: <span className="font-mono">{doc.files.join(', ')}</span>
          </div>
        )}
      </div>
    </Dialog>
  )
}

const TEMPLATE = `## When this applies

Describe the situations this covers.

## How to do it

- Concrete rules: fonts, colours, timings, what to avoid.
- Steps to follow, and which Lumen tools to use.

## Check

How to verify the result before saying it's done.`

function SkillEditor({ folder, onClose }: { folder?: string; onClose: () => void }) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [body, setBody] = useState(folder ? '' : TEMPLATE)
  const [busy, setBusy] = useState(Boolean(folder))
  useEffect(() => {
    if (!folder || !api) return
    void api.skills
      .read('user' as SkillSource, folder)
      .then((doc) => {
        setName(doc.name)
        setDescription(doc.description)
        setBody(doc.body)
      })
      .catch((err) => toast.error('Couldn’t open that skill', { description: errorText(err) }))
      .finally(() => setBusy(false))
  }, [folder])
  const save = async () => {
    if (!api) return
    setBusy(true)
    try {
      const skill = await api.skills.save({ folder, name, description, body })
      await refreshSkills()
      toast.success(folder ? `Saved “${skill.name}”` : `Added the “${skill.name}” skill`)
      onClose()
    } catch (err) {
      toast.error('Couldn’t save the skill', { description: errorText(err) })
      setBusy(false)
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={folder ? 'Edit skill' : 'New skill'} className="w-[min(760px,calc(100vw-32px))]">
      <div className="space-y-3 px-5 pb-5">
        <label className="block">
          <span className="mb-1.5 block text-2xs font-semibold tracking-wider text-fg-4 uppercase">Name</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. brand-titles" disabled={busy} />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-2xs font-semibold tracking-wider text-fg-4 uppercase">When to use it</span>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Use when adding titles or lower thirds for Acme videos" disabled={busy} />
          <span className="mt-1 block text-2xs text-fg-4">The Copilot decides from this line whether the skill applies, so say when, not just what.</span>
        </label>
        <label className="block">
          <span className="mb-1.5 block text-2xs font-semibold tracking-wider text-fg-4 uppercase">Instructions (markdown)</span>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            disabled={busy}
            spellCheck={false}
            className="block h-[38vh] w-full resize-none rounded-lg bg-black/30 px-3 py-2.5 font-mono text-[12px] leading-relaxed text-fg-2 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)] outline-none focus:shadow-[inset_0_0_0_1px_var(--color-accent)]"
          />
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={busy || !name.trim() || !description.trim()}>
            {busy ? <LoaderCircle className="animate-spin" /> : null}
            {folder ? 'Save' : 'Add skill'}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
