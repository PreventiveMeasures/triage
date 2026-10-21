// Set for a team that is not App: `findings`, its rows (with `countFindings`),
// and `appReports`, set by the managed catalog: how many reports open in App mode alone.
export type TeamAppMetadata = { appMode: true; appFindings: number } | { appMode: false; appReports?: number; findings?: number }
export function managedTeamAppMetadata(workspace: readonly { filename: string; data: unknown }[] & { links?: readonly (readonly string[])[] },
  options?: { countFindings?: boolean }): TeamAppMetadata
export function managedTeamRevalidationConflicted(workspace: readonly { filename: string; data: unknown }[] & { links?: readonly (readonly string[])[] }): boolean
export function managedTeamAppRows(workspace: readonly { filename: string; data: unknown }[] & { links?: readonly (readonly string[])[] }): Set<string> | null
export function managedTeamLens(workspace: readonly { filename: string; data: unknown }[] & { links?: readonly (readonly string[])[] }): { drop: boolean; detail: boolean; upstream: boolean }
export interface ManagedTeamView {
  app: TeamAppMetadata
  rows: Set<string> | null
  conflicted(): boolean
  lens(): { drop: boolean; detail: boolean; upstream: boolean }
}
export function managedTeamView(workspace: readonly { filename: string; data: unknown }[] & { links?: readonly (readonly string[])[] }): ManagedTeamView
