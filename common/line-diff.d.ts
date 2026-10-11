// Type declarations for `common/line-diff.js`, for `.ts` callers.

// Lines `a[a0..a1)` replaced by `b[b0..b1)`.
export interface ChangeBlock { a0: number; a1: number; b0: number; b1: number }

export function textLines(text: string): string[]
export function changeBlocks(before: string, after: string, ignoreWhitespace?: boolean): ChangeBlock[]
export function blocksHold(before: string, after: string, blocks: unknown, ignoreWhitespace?: boolean): boolean
export function markedBlocks(before: string, given: string, after: string, ignoreWhitespace?: boolean): ChangeBlock[] | null
