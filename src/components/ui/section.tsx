import { ChevronRight } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useState, type ReactNode } from 'react'
import { cn } from '@/lib/cn'

interface SectionProps {
  title: ReactNode
  icon?: ReactNode
  actions?: ReactNode
  defaultOpen?: boolean
  children: ReactNode
  className?: string
}

/** Collapsible inspector section with a springy height animation. */
export function Section({ title, icon, actions, defaultOpen = true, children, className }: SectionProps) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className={cn('border-b border-line last:border-b-0', className)}>
      <div className="flex h-10 items-center gap-2 px-4">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="group/sec -ml-1 flex min-w-0 flex-1 items-center gap-2 rounded-md py-1 pl-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
        >
          <ChevronRight className={cn('size-3.5 shrink-0 text-fg-4 transition-transform duration-200 group-hover/sec:text-fg-3', open && 'rotate-90')} />
          {icon && <span className="text-fg-3 [&_svg]:size-3.5">{icon}</span>}
          <span className="truncate text-sm font-semibold text-fg">{title}</span>
        </button>
        {actions && <div className="flex items-center gap-0.5">{actions}</div>}
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ height: { type: 'spring', stiffness: 420, damping: 40 }, opacity: { duration: 0.15 } }}
            className="overflow-hidden"
          >
            <div className="px-4 pt-0.5 pb-4">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  )
}

/** Label + control row used throughout the inspector. */
export function Row({ label, children, trailing, className }: { label: ReactNode; children: ReactNode; trailing?: ReactNode; className?: string }) {
  return (
    <div className={cn('grid min-h-8 grid-cols-[76px_1fr_auto] items-center gap-2', className)}>
      <span className="truncate text-xs text-fg-3">{label}</span>
      <div className="flex min-w-0 items-center gap-2">{children}</div>
      <div className="flex w-5 justify-end">{trailing}</div>
    </div>
  )
}
