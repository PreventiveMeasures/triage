// Managed comments are independent records, shared by reports containing the
// same finding. Imported and legacy comments may lack attribution or dates.
export interface ManagedComment {
  id: string
  findingId: string
  body: string
  authorId: string | null
  authorLogin: string | null
  createdAt: number | null
  updatedAt: number | null
  version: number
}

export const MAX_COMMENT_TEXT = 10_000

export function compareManagedComments(a: ManagedComment, b: ManagedComment): number {
  if (a.createdAt == null && b.createdAt != null) return -1
  if (a.createdAt != null && b.createdAt == null) return 1
  const byDate = (a.createdAt ?? 0) - (b.createdAt ?? 0)
  if (byDate !== 0) return byDate
  if (a.id === b.id) return 0
  return a.id < b.id ? -1 : 1
}

export function parseCommentBody(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_COMMENT_TEXT) return null
  return value.trim() || null
}
