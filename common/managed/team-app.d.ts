// Set for a team that is not App: `findings`, its rows (with `countFindings`),
// and `appReports`, set by the managed catalog: how many reports open in App mode alone.
export type TeamAppMetadata = { appMode: true; appFindings: number } | { appMode: false; appReports?: number; findings?: number }
// A team's reports, each switched to open on Confirmed or not (`confirmedDefault`), and its links.
type TeamWorkspace = readonly { filename: string; data: unknown; confirmedDefault?: boolean | undefined }[] & { links?: readonly (readonly string[])[] }
export function managedTeamAppMetadata(workspace: TeamWorkspace, options?: { countFindings?: boolean }): TeamAppMetadata
export function managedTeamRevalidationConflicted(workspace: TeamWorkspace): boolean
export function managedTeamAppRows(workspace: TeamWorkspace): Set<string> | null
export function managedTeamLens(workspace: TeamWorkspace): { drop: boolean; detail: boolean; upstream: boolean }
export function managedReportConfirmedDefaultOffered(filename: string, data: unknown): boolean
export interface ManagedTeamView {
  app: TeamAppMetadata
  rows: Set<string> | null
  conflicted(): boolean
  lens(): { drop: boolean; detail: boolean; upstream: boolean }
}
export function managedTeamView(workspace: TeamWorkspace): ManagedTeamView
