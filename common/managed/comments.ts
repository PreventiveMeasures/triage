// Managed comments are independent records, shared by reports containing the
// same finding. Imported and legacy comments may lack attribution or dates.
export interface ManagedComment {
  id: string
  findingId: string
  body: string
  authorId: string | null
  authorLogin: string | null
  // The name its author chose to show (managed_user.name), as it is now: null
  // for one with none, one no longer a user, and to a public link's readers.
  authorName: string | null
  createdAt: number | null
  updatedAt: number | null
  version: number
}

export const MAX_COMMENT_TEXT = 10_000

// Who a comment shows as by: its author's name, else their login; null for
// one with neither, as an imported or legacy one is.
export function commentAuthorName(comment: { authorName?: string | null; authorLogin?: string | null }): string | null {
  return comment.authorName?.trim() || comment.authorLogin || null
}

// Callers also enforce write access to the report containing the finding.
// Admins can remove comments with no linked user, but cannot claim authorship.
export function canDeleteComment(comment: Pick<ManagedComment, 'authorId'>, actor: { id: string; role: string } | null | undefined): boolean {
  return actor != null && (comment.authorId === actor.id || (comment.authorId == null && actor.role === 'admin'))
}

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
