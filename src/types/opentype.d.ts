// Minimal types for the parts of opentype.js 2.x we use (the package ships none).
declare module 'opentype.js' {
  export interface PathCommand {
    type: 'M' | 'L' | 'Q' | 'C' | 'Z'
    x?: number
    y?: number
    x1?: number
    y1?: number
    x2?: number
    y2?: number
  }

  export interface Path {
    commands: PathCommand[]
  }

  export interface Glyph {
    advanceWidth?: number
    getPath(x: number, y: number, fontSize: number): Path
  }

  export interface RenderOptions {
    kerning?: boolean
    letterSpacing?: number
  }

  /** Name-table entries by language, e.g. { en: 'Inter Tight' }. */
  export type LocalizedName = Partial<Record<string, string>>

  export interface Font {
    names: { fontFamily?: LocalizedName; fullName?: LocalizedName; fontSubfamily?: LocalizedName }
    unitsPerEm: number
    ascender: number
    descender: number
    getPath(text: string, x: number, y: number, fontSize: number, options?: RenderOptions): Path
    getAdvanceWidth(text: string, fontSize: number, options?: RenderOptions): number
    charToGlyph(char: string): Glyph
    getKerningValue(left: Glyph, right: Glyph): number
    forEachGlyph(
      text: string,
      x: number,
      y: number,
      fontSize: number,
      options: RenderOptions | undefined,
      callback: (glyph: Glyph, x: number, y: number, fontSize: number) => void,
    ): number
  }

  export function parse(buffer: ArrayBuffer): Font
}
