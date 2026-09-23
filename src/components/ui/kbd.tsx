import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { formatShortcut } from '@/lib/platform'

// Arrow glyphs are too thin at keycap size in most UI fonts — draw them as icons.
const ICONS: Record<string, ReactNode> = {
  '←': <ArrowLeft className="size-2.5" strokeWidth={2.5} />,
  '→': <ArrowRight className="size-2.5" strokeWidth={2.5} />,
  '↑': <ArrowUp className="size-2.5" strokeWidth={2.5} />,
  '↓': <ArrowDown className="size-2.5" strokeWidth={2.5} />,
}

export function Kbd({ combo, className }: { combo: string; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-0.5', className)}>
      {formatShortcut(combo).map((key, i) => (
        <kbd
          key={i}
          className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[5px] bg-white/[0.07] px-1 font-sans text-2xs font-medium text-fg-3 shadow-[inset_0_-1px_0_rgb(255_255_255/0.06)]"
        >
          {ICONS[key] ?? key}
        </kbd>
      ))}
    </span>
  )
}
