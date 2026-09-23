import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { Tip } from './tooltip'

type Variant = 'primary' | 'secondary' | 'ghost' | 'outline' | 'ai' | 'danger' | 'white'
type Size = 'xs' | 'sm' | 'md' | 'lg'

const base =
  'inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-control font-medium select-none outline-none transition-[background-color,color,box-shadow,transform,filter,opacity] duration-150 ease-out active:scale-[0.97] disabled:pointer-events-none disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-accent/70 [&_svg]:shrink-0'

const variants: Record<Variant, string> = {
  primary:
    'bg-accent text-accent-fg shadow-[inset_0_1px_0_rgb(255_255_255/0.35),0_1px_2px_rgb(0_0_0/0.4),0_6px_20px_-8px_rgb(214_238_0/0.45)] hover:bg-accent-2 disabled:bg-white/[0.07] disabled:text-fg-4 disabled:shadow-none disabled:opacity-100',
  secondary: 'bg-surface-3 text-fg shadow-control hover:bg-surface-4',
  ghost: 'text-fg-2 hover:bg-white/[0.06] hover:text-fg',
  outline: 'text-fg-2 ring-1 ring-inset ring-line-2 hover:bg-white/[0.04] hover:text-fg',
  ai: 'bg-ai text-accent-fg shadow-[inset_0_1px_0_rgb(255_255_255/0.35),0_8px_24px_-10px_rgb(94_242_166/0.55)] hover:brightness-110 disabled:bg-none disabled:bg-white/[0.07] disabled:text-fg-4 disabled:shadow-none disabled:opacity-100',
  danger: 'bg-danger/12 text-danger hover:bg-danger/20',
  white: 'bg-white text-black shadow-[0_1px_2px_rgb(0_0_0/0.3)] hover:bg-white/90',
}

const sizes: Record<Size, string> = {
  xs: 'h-6 px-2 text-xs [&_svg]:size-3.5',
  sm: 'h-7 px-2.5 text-sm [&_svg]:size-3.5',
  md: 'h-8 px-3 text-sm [&_svg]:size-4',
  lg: 'h-10 px-4 text-md rounded-[10px] [&_svg]:size-4',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', className, type = 'button', ...props },
  ref,
) {
  return <button ref={ref} type={type} className={cn(base, variants[variant], sizes[size], className)} {...props} />
})

type IconSize = 'xs' | 'sm' | 'md' | 'lg'

const iconSizes: Record<IconSize, string> = {
  xs: 'size-6 rounded-md [&_svg]:size-3.5',
  sm: 'size-7 rounded-[7px] [&_svg]:size-4',
  md: 'size-8 [&_svg]:size-[17px]',
  lg: 'size-9 rounded-[10px] [&_svg]:size-[18px]',
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string
  shortcut?: string
  size?: IconSize
  active?: boolean
  tooltipSide?: 'top' | 'bottom' | 'left' | 'right'
  children: ReactNode
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, shortcut, size = 'sm', active, tooltipSide, className, type = 'button', ...props },
  ref,
) {
  return (
    <Tip content={label} shortcut={shortcut} side={tooltipSide}>
      <button
        ref={ref}
        type={type}
        aria-label={label}
        aria-pressed={active}
        className={cn(
          base,
          iconSizes[size],
          active ? 'bg-accent/16 text-accent-2 hover:bg-accent/22' : 'text-fg-3 hover:bg-white/[0.06] hover:text-fg',
          className,
        )}
        {...props}
      />
    </Tip>
  )
})
