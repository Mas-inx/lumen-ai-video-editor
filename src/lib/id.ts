import { customAlphabet } from 'nanoid'

const nano = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 10)

/** Prefixed ids read well in logs, history labels and MCP tool calls: `clip_k3j9x…`. */
export const uid = (prefix: string) => `${prefix}_${nano()}`
