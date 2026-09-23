import { ChevronRight } from 'lucide-react'
import { ContextMenu, DropdownMenu } from 'radix-ui'
import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { Kbd } from './kbd'

const contentClass =
  'popover z-[100] min-w-[220px] overflow-hidden p-1 data-[state=open]:animate-pop-in data-[state=closed]:animate-pop-out'

const itemClass =
  'group/item relative flex h-8 cursor-default items-center gap-2.5 rounded-[7px] px-2 text-sm text-fg-2 outline-none select-none data-[highlighted]:bg-white/[0.07] data-[highlighted]:text-fg data-[disabled]:pointer-events-none data-[disabled]:opacity-40 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-fg-3 data-[highlighted]:[&_svg]:text-fg-2'

interface ItemProps {
  icon?: ReactNode
  shortcut?: string
  danger?: boolean
  disabled?: boolean
  onSelect?: () => void
  children: ReactNode
}

// ─── Dropdown ────────────────────────────────────────────────────────────

export const Menu = DropdownMenu.Root
export const MenuTrigger = DropdownMenu.Trigger

export function MenuContent({ children, align = 'start', side = 'bottom', className }: { children: ReactNode; align?: 'start' | 'center' | 'end'; side?: 'top' | 'bottom' | 'left' | 'right'; className?: string }) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        align={align}
        side={side}
        sideOffset={6}
        collisionPadding={8}
        className={cn(contentClass, 'origin-(--radix-dropdown-menu-content-transform-origin)', className)}
      >
        {children}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  )
}

export function MenuItem({ icon, shortcut, danger, disabled, onSelect, children }: ItemProps) {
  return (
    <DropdownMenu.Item disabled={disabled} onSelect={onSelect} className={cn(itemClass, danger && 'text-danger data-[highlighted]:text-danger [&_svg]:text-danger/80')}>
      {icon}
      <span className="flex-1 truncate">{children}</span>
      {shortcut && <Kbd combo={shortcut} />}
    </DropdownMenu.Item>
  )
}

export function MenuSeparator() {
  return <DropdownMenu.Separator className="mx-1 my-1 h-px bg-line" />
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <DropdownMenu.Label className="px-2 pt-1.5 pb-1 text-2xs font-semibold tracking-wider text-fg-4 uppercase">{children}</DropdownMenu.Label>
}

export function MenuSub({ icon, label, children }: { icon?: ReactNode; label: ReactNode; children: ReactNode }) {
  return (
    <DropdownMenu.Sub>
      <DropdownMenu.SubTrigger className={cn(itemClass, 'data-[state=open]:bg-white/[0.07]')}>
        {icon}
        <span className="flex-1">{label}</span>
        <ChevronRight className="!size-3.5" />
      </DropdownMenu.SubTrigger>
      <DropdownMenu.Portal>
        <DropdownMenu.SubContent sideOffset={6} alignOffset={-4} className={cn(contentClass, 'origin-(--radix-dropdown-menu-content-transform-origin)')}>
          {children}
        </DropdownMenu.SubContent>
      </DropdownMenu.Portal>
    </DropdownMenu.Sub>
  )
}

// ─── Context menu ────────────────────────────────────────────────────────

export const ContextRoot = ContextMenu.Root
export const ContextTrigger = ContextMenu.Trigger

export function ContextContent({ children }: { children: ReactNode }) {
  return (
    <ContextMenu.Portal>
      <ContextMenu.Content collisionPadding={8} className={cn(contentClass, 'origin-(--radix-context-menu-content-transform-origin)')}>
        {children}
      </ContextMenu.Content>
    </ContextMenu.Portal>
  )
}

export function ContextItem({ icon, shortcut, danger, disabled, onSelect, children }: ItemProps) {
  return (
    <ContextMenu.Item disabled={disabled} onSelect={onSelect} className={cn(itemClass, danger && 'text-danger data-[highlighted]:text-danger [&_svg]:text-danger/80')}>
      {icon}
      <span className="flex-1 truncate">{children}</span>
      {shortcut && <Kbd combo={shortcut} />}
    </ContextMenu.Item>
  )
}

export function ContextSeparator() {
  return <ContextMenu.Separator className="mx-1 my-1 h-px bg-line" />
}

export function ContextSub({ icon, label, children }: { icon?: ReactNode; label: ReactNode; children: ReactNode }) {
  return (
    <ContextMenu.Sub>
      <ContextMenu.SubTrigger className={cn(itemClass, 'data-[state=open]:bg-white/[0.07]')}>
        {icon}
        <span className="flex-1">{label}</span>
        <ChevronRight className="!size-3.5" />
      </ContextMenu.SubTrigger>
      <ContextMenu.Portal>
        <ContextMenu.SubContent sideOffset={6} alignOffset={-4} className={cn(contentClass, 'origin-(--radix-context-menu-content-transform-origin)')}>
          {children}
        </ContextMenu.SubContent>
      </ContextMenu.Portal>
    </ContextMenu.Sub>
  )
}
