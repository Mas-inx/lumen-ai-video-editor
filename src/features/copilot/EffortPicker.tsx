import { Check, ChevronDown, Gauge } from 'lucide-react'
import { useState } from 'react'
import { EFFORT_INFO, type Effort } from '@shared/ai'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { LOCAL_AGENT_NAMES, setEffort, targetEfforts, useAi } from '@/integrations/ai'
import { cn } from '@/lib/cn'

/** How hard the chosen model thinks. Only shown when that model has an effort setting. */
export function EffortPicker() {
  const target = useAi((s) => s.target)
  // Re-render when model lists and agent catalogs land: they carry the levels.
  const models = useAi((s) => s.models)
  const agents = useAi((s) => s.localAgents)
  const [open, setOpen] = useState(false)
  void models
  void agents
  const { levels, defaultEffort, fromSettings } = targetEfforts(target)
  if (!target || !levels.length) return null

  const current = target.effort && levels.includes(target.effort) ? target.effort : undefined
  const source = fromSettings && target.kind === 'local' ? ` — from your ${LOCAL_AGENT_NAMES[target.agent]} settings` : ''
  const pick = (effort: Effort | undefined) => {
    setEffort(effort)
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title="Effort — how hard the model thinks"
          className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 font-medium text-fg-3 outline-none transition-colors hover:bg-white/[0.06] hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/60 data-[state=open]:bg-white/[0.07] data-[state=open]:text-fg"
        >
          <Gauge className={cn('size-3', current && 'text-accent-2')} />
          {current ? EFFORT_INFO[current].label : 'Default'}
          <ChevronDown className="size-3 text-fg-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[264px] p-1.5">
        <div className="px-2 pt-1.5 pb-2">
          <div className="text-sm font-semibold text-fg">Effort</div>
          <p className="mt-0.5 text-2xs leading-relaxed text-fg-4">How hard the model thinks before it edits. Higher is slower and uses more of your plan or credits.</p>
        </div>
        <Option title="Default" hint={defaultEffort ? `${EFFORT_INFO[defaultEffort].label}${source}` : 'The model’s own setting'} selected={!current} onSelect={() => pick(undefined)} />
        {levels.map((effort) => (
          <Option key={effort} title={EFFORT_INFO[effort].label} hint={EFFORT_INFO[effort].hint} selected={current === effort} onSelect={() => pick(effort)} />
        ))}
      </PopoverContent>
    </Popover>
  )
}

function Option({ title, hint, selected, onSelect }: { title: string; hint: string; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn('flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left outline-none transition-colors hover:bg-white/[0.06] focus-visible:bg-white/[0.06]', selected && 'bg-white/[0.04]')}
    >
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] text-fg">{title}</span>
        <span className="block truncate text-[10.5px] text-fg-4">{hint}</span>
      </span>
      {selected && <Check className="size-3.5 shrink-0 text-accent-2" />}
    </button>
  )
}
