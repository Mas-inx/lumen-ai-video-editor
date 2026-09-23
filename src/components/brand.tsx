import { useId } from 'react'
import { cn } from '@/lib/cn'

export const APP_NAME = 'Lumen'

export function LogoMark({ className }: { className?: string }) {
  const id = useId()
  return (
    <svg viewBox="0 0 24 24" className={cn('size-6', className)} aria-hidden>
      <defs>
        <linearGradient id={`${id}-g`} x1="2" y1="2" x2="22" y2="22" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#efff7a" />
          <stop offset="0.5" stopColor="#d6ee00" />
          <stop offset="1" stopColor="#5ef2a6" />
        </linearGradient>
        <linearGradient id={`${id}-s`} x1="0" y1="0" x2="0" y2="24" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#fff" stopOpacity="0.35" />
          <stop offset="0.5" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect width="24" height="24" rx="7" fill={`url(#${id}-g)`} />
      <rect width="24" height="24" rx="7" fill={`url(#${id}-s)`} />
      <path d="M9.2 7.6v8.8c0 .66.73 1.06 1.28.7l6.9-4.4a.83.83 0 0 0 0-1.4l-6.9-4.4a.83.83 0 0 0-1.28.7Z" fill="#0b0c02" />
      <path d="M18.4 3.6l.45 1.25 1.25.45-1.25.45-.45 1.25-.45-1.25-1.25-.45 1.25-.45z" fill="#0b0c02" opacity="0.9" />
    </svg>
  )
}

/** Four-point sparkle filled with the AI gradient — the visual signature of Copilot. */
export function AiSparkle({ className }: { className?: string }) {
  const id = useId()
  return (
    <svg viewBox="0 0 24 24" className={cn('size-4', className)} aria-hidden>
      <defs>
        <linearGradient id={id} x1="3" y1="3" x2="21" y2="21" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#e5f75c" />
          <stop offset="0.55" stopColor="#5ef2a6" />
          <stop offset="1" stopColor="#36d6f2" />
        </linearGradient>
      </defs>
      <path
        d="M12 2.5c.35 0 .65.24.73.58l.9 3.7a5 5 0 0 0 3.6 3.6l3.7.9a.75.75 0 0 1 0 1.46l-3.7.9a5 5 0 0 0-3.6 3.6l-.9 3.7a.75.75 0 0 1-1.46 0l-.9-3.7a5 5 0 0 0-3.6-3.6l-3.7-.9a.75.75 0 0 1 0-1.46l3.7-.9a5 5 0 0 0 3.6-3.6l.9-3.7A.75.75 0 0 1 12 2.5Z"
        fill={`url(#${id})`}
      />
      <path d="M19 2.8l.3.85.85.3-.85.3-.3.85-.3-.85-.85-.3.85-.3z" fill={`url(#${id})`} />
    </svg>
  )
}
