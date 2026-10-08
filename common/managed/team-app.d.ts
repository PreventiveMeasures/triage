export type TeamAppMetadata = { appMode: true; appFindings: number } | { appMode: false }
export function managedTeamAppMetadata(workspace: readonly { filename: string; data: unknown }[] & { links?: readonly (readonly string[])[] }): TeamAppMetadata
