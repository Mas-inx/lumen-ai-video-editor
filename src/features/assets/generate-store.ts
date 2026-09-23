import { create } from 'zustand'

export type GenerateEngine = 'media' | '3d' | 'motion'
export type GenerateMode = 'video' | 'image' | 'voice' | 'music' | 'sfx'

/** Which generator the Generate panel shows (other panels and the Integrations hub can switch it). */
export const useGenerate = create<{ engine: GenerateEngine; mode: GenerateMode }>(() => ({ engine: 'media', mode: 'video' }))
