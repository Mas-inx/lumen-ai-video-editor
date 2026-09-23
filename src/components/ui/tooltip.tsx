import { Tooltip } from 'radix-ui'
import type { ReactNode } from 'react'
import { Kbd } from './kbd'

export const TooltipProvider = Tooltip.Provider

interface TipProps {
  content: ReactNode
  shortcut?: string
  side?: 'top' | 'bottom' | 'left' | 'right'
  children: ReactNode
  disabled?: boolean
}

export function Tip({ content, shortcut, side = 'top', children, disabled }: TipProps) {
  if (disabled) return children
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          side={side}
          sideOffset={6}
          collisionPadding={8}
          className="popover z-[100] flex items-center gap-2 rounded-lg px-2 py-1 text-xs font-medium text-fg origin-(--radix-tooltip-content-transform-origin) data-[state=delayed-open]:animate-pop-in data-[state=instant-open]:animate-pop-in"
        >
          {content}
          {shortcut && <Kbd combo={shortcut} />}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  )
}
