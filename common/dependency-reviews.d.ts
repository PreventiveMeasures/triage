export type ReviewVerdict = 'accept' | 'accept-with-nits' | 'request-changes' | 'reject'
export interface ReviewSummary {
  coverage: 'full' | 'partial' | null
  checkedFiles: number | null
  totalFiles: number | null
  verdictLimit: ReviewVerdict
}
export const REVIEW_VERDICTS: Record<ReviewVerdict, string>
export function summarizeReview(entries: { file: string | null; status: ReviewVerdict | null }[], files: string[] | null): ReviewSummary
export function allowedReviewVerdicts(entries: { file: string | null; status: ReviewVerdict | null }[]): ReviewVerdict[]
export function needsPackageJsonReview(entries: { file: string | null; status: ReviewVerdict | null }[], files: string[]): boolean
export function parseReviewNotes(comment: string): { text: string; bullet: boolean }[]
export function auditMarkdown(review: ReviewSummary & {
  package: string; version: string; integrity: string; basePackage: string | null; baseVersion: string | null
  publishedAt: number | null; revokedAt: number | null; entries: { file: string | null; comment: string }[]
  status: ReviewVerdict | null; comment: string
}): string | null
