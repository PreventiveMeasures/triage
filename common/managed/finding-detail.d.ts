export const FINDING_DETAIL_FIELDS: readonly string[]
export function liteReportData(data: unknown, options?: { fold?: boolean; shown?: ReadonlySet<string> | null }): unknown
export function liteWorkspace<T extends { filename: string; data: unknown }>(reports: readonly T[], links: readonly (readonly string[])[]): {
  reports: T[]; folded: false | 'rows' | 'app'; lens: { drop: boolean; detail: boolean; upstream: boolean } | null
}
