import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

// Teach tailwind-merge about our custom theme scales so they merge instead of stacking.
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      shadow: ['panel', 'pop', 'control'],
      radius: ['panel', 'card', 'control'],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
