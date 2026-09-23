import { X } from 'lucide-react'
import { Dialog as RadixDialog } from 'radix-ui'
import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

interface DialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title?: ReactNode
  description?: ReactNode
  children: ReactNode
  className?: string
  /** Hide the default header (for fully custom layouts). */
  bare?: boolean
  /** Focus the dialog itself on open instead of its first control. */
  focusContent?: boolean
}

export function Dialog({ open, onOpenChange, title, description, children, className, bare, focusContent }: DialogProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-[90] bg-black/55 backdrop-blur-[3px] data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out" />
        <RadixDialog.Content
          {...(!description && { 'aria-describedby': undefined })}
          onOpenAutoFocus={
            focusContent
              ? (e) => {
                  e.preventDefault()
                  ;(e.currentTarget as HTMLElement).focus()
                }
              : undefined
          }
          className={cn(
            'popover fixed top-1/2 left-1/2 z-[95] max-h-[calc(100vh-48px)] w-[min(560px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-2xl outline-none data-[state=open]:animate-dialog-in data-[state=closed]:animate-dialog-out',
            className,
          )}
        >
          {bare ? (
            <RadixDialog.Title className="sr-only">{title}</RadixDialog.Title>
          ) : (
            <div className="flex items-start justify-between gap-4 px-5 pt-5 pb-3">
              <div>
                <RadixDialog.Title className="text-lg font-semibold tracking-tight text-fg">{title}</RadixDialog.Title>
                {description && <RadixDialog.Description className="mt-0.5 text-sm text-fg-3">{description}</RadixDialog.Description>}
              </div>
              <RadixDialog.Close className="-mt-1 -mr-1 rounded-lg p-1.5 text-fg-3 outline-none transition-colors hover:bg-white/[0.06] hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/60">
                <X className="size-4" />
              </RadixDialog.Close>
            </div>
          )}
          {bare && description && <RadixDialog.Description className="sr-only">{description}</RadixDialog.Description>}
          {children}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}
