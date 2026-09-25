// Managed comments are independent records, shared by reports containing the
// same finding. Null attribution is valid for imported and legacy comments.
export interface ManagedComment {
  id: string
  findingId: string
  body: string
  authorId: string | null
  authorLogin: string | null
  createdAt: number
  updatedAt: number
  version: number
}

export const MAX_COMMENT_TEXT = 10_000

export function parseCommentBody(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_COMMENT_TEXT) return null
  return value.trim() || null
}
