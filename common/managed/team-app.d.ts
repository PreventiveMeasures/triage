// `appReports`, set by the managed catalog: how many reports open in App mode alone.
export type TeamAppMetadata = { appMode: true; appFindings: number } | { appMode: false; appReports?: number }
export function managedTeamAppMetadata(workspace: readonly { filename: string; data: unknown }[] & { links?: readonly (readonly string[])[] }): TeamAppMetadata
