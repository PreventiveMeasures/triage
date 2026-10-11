// Type declarations for `common/rename-diff.js`, for `.ts` callers.

import type { ChangeBlock } from './line-diff.js'

export interface RenameDiff { blocks: ChangeBlock[]; renamed: number[] }

export function renameDiff(before: string, after: string, options?: { ignoreWhitespace?: boolean }): RenameDiff
