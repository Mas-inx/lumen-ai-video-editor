import { Check, ChevronDown } from 'lucide-react'
import { Select as RadixSelect } from 'radix-ui'
import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

interface SelectProps<T extends string> {
  value: T
  onChange: (value: T) => void
  options: { value: T; label: ReactNode; hint?: ReactNode; disabled?: boolean }[]
  className?: string
  size?: 'sm' | 'md'
  'aria-label'?: string
}

export function Select<T extends string>({ value, onChange, options, className, size = 'sm', ...rest }: SelectProps<T>) {
  return (
    <RadixSelect.Root value={value} onValueChange={(v) => onChange(v as T)}>
      <RadixSelect.Trigger
        aria-label={rest['aria-label']}
        className={cn(
          'group/select inline-flex min-w-0 items-center justify-between gap-2 rounded-[7px] bg-white/[0.045] px-2 text-sm text-fg shadow-[inset_0_0_0_1px_rgb(255_255_255/0.05)] outline-none transition-colors hover:bg-white/[0.07] focus-visible:ring-2 focus-visible:ring-accent/60 data-[state=open]:bg-white/[0.08]',
          size === 'sm' ? 'h-7' : 'h-8',
          className,
        )}
      >
        <span className="min-w-0 truncate">
          <RadixSelect.Value />
        </span>
        <RadixSelect.Icon>
          <ChevronDown className="size-3.5 text-fg-3 transition-transform duration-200 group-data-[state=open]/select:rotate-180" />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Portal>
        <RadixSelect.Content
          position="popper"
          sideOffset={6}
          className="popover z-[100] max-h-(--radix-select-content-available-height) min-w-(--radix-select-trigger-width) overflow-hidden p-1 origin-(--radix-select-content-transform-origin) data-[state=open]:animate-pop-in data-[state=closed]:animate-pop-out"
        >
          <RadixSelect.Viewport>
            {options.map((o) => (
              <RadixSelect.Item
                key={o.value}
                value={o.value}
                disabled={o.disabled}
                className="relative flex h-7 cursor-default items-center gap-2 rounded-md pr-7 pl-2 text-sm text-fg-2 outline-none select-none data-[disabled]:opacity-40 data-[highlighted]:bg-white/[0.07] data-[highlighted]:text-fg data-[state=checked]:text-fg"
              >
                <RadixSelect.ItemText>{o.label}</RadixSelect.ItemText>
                {o.hint && <span className="ml-auto text-xs text-fg-4">{o.hint}</span>}
                <RadixSelect.ItemIndicator className="absolute right-2">
                  <Check className="size-3.5 text-accent-2" />
                </RadixSelect.ItemIndicator>
              </RadixSelect.Item>
            ))}
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  )
}
