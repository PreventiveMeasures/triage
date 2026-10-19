// Set for a team that is not App: `findings`, its rows (with `countFindings`),
// and `appReports`, set by the managed catalog: how many reports open in App mode alone.
export type TeamAppMetadata = { appMode: true; appFindings: number } | { appMode: false; appReports?: number; findings?: number }
export function managedTeamAppMetadata(workspace: readonly { filename: string; data: unknown }[] & { links?: readonly (readonly string[])[] },
  options?: { countFindings?: boolean }): TeamAppMetadata
export function managedTeamRevalidationConflicted(workspace: readonly { filename: string; data: unknown }[] & { links?: readonly (readonly string[])[] }): boolean
