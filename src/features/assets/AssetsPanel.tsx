import { Aperture, Blend, Clapperboard, Music, Sparkles, Type, WandSparkles } from 'lucide-react'
import { motion } from 'motion/react'
import type { ReactNode } from 'react'
import { AiSparkle } from '@/components/brand'
import { Tip } from '@/components/ui/tooltip'
import { useUI, type LeftTab } from '@/editor/ui-store'
import { cn } from '@/lib/cn'
import { AudioPanel } from './AudioPanel'
import { EffectsPanel } from './EffectsPanel'
import { GeneratePanel } from './GeneratePanel'
import { LooksPanel } from './LooksPanel'
import { MediaPanel } from './MediaPanel'
import { TextPanel } from './TextPanel'
import { TransitionsPanel } from './TransitionsPanel'

const TABS: { id: LeftTab; label: string; icon: ReactNode; hint: string }[] = [
  { id: 'media', label: 'Media', icon: <Clapperboard />, hint: 'Your footage, photos & audio' },
  { id: 'audio', label: 'Audio', icon: <Music />, hint: 'Music & sound effects' },
  { id: 'text', label: 'Text', icon: <Type />, hint: 'Titles & captions' },
  { id: 'effects', label: 'Effects', icon: <Sparkles />, hint: 'Blur, glow, grain & more' },
  { id: 'transitions', label: 'Transitions', icon: <Blend />, hint: 'Between shots' },
  { id: 'looks', label: 'Looks', icon: <Aperture />, hint: 'One-click color grades' },
]

export function AssetsPanel() {
  const tab = useUI((s) => s.leftTab)
  const setTab = useUI((s) => s.setLeftTab)

  return (
    <div className="panel flex h-full overflow-hidden">
      <nav className="flex w-[62px] shrink-0 flex-col items-center gap-0.5 border-r border-line py-2">
        {TABS.map((t) => (
          <RailButton key={t.id} active={tab === t.id} onClick={() => setTab(t.id)} label={t.label} hint={t.hint}>
            {t.icon}
          </RailButton>
        ))}
        <div className="mt-auto" />
        <RailButton active={tab === 'generate'} onClick={() => setTab('generate')} label="Generate" hint="AI images, video, voice & music" ai>
          {tab === 'generate' ? <WandSparkles /> : <AiSparkle className="!size-[18px]" />}
        </RailButton>
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">
        {tab === 'media' && <MediaPanel />}
        {tab === 'audio' && <AudioPanel />}
        {tab === 'text' && <TextPanel />}
        {tab === 'effects' && <EffectsPanel />}
        {tab === 'transitions' && <TransitionsPanel />}
        {tab === 'looks' && <LooksPanel />}
        {tab === 'generate' && <GeneratePanel />}
      </div>
    </div>
  )
}

function RailButton({ active, onClick, label, hint, ai, children }: { active: boolean; onClick: () => void; label: string; hint: string; ai?: boolean; children: ReactNode }) {
  return (
    <Tip content={hint} side="right">
      <button
        type="button"
        onClick={onClick}
        aria-current={active}
        className={cn(
          'group relative flex w-[52px] flex-col items-center gap-1 rounded-[10px] pt-2 pb-1.5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/60',
          active ? 'text-fg' : 'text-fg-3 hover:text-fg-2',
        )}
      >
        {active && (
          <motion.span
            layoutId="rail-active"
            className={cn(
              'absolute inset-0 rounded-[10px]',
              ai
                ? 'bg-[linear-gradient(120deg,rgb(214_238_0/0.18),rgb(94_242_166/0.14),rgb(54_214_242/0.12))] shadow-[inset_0_0_0_1px_rgb(94_242_166/0.25)]'
                : 'bg-white/[0.07] shadow-[inset_0_0_0_1px_rgb(255_255_255/0.05)]',
            )}
            transition={{ type: 'spring', stiffness: 500, damping: 38 }}
          />
        )}
        <span className={cn('relative [&_svg]:size-[18px] transition-transform duration-200 group-hover:-translate-y-px', active && !ai && '[&_svg]:text-accent-2')}>{children}</span>
        <span className="relative text-[10px] leading-none font-medium">{label}</span>
      </button>
    </Tip>
  )
}
