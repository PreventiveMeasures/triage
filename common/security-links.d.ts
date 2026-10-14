export function securityLinks(links?: Iterable<readonly string[]>): {
  add(ids: readonly string[]): void
  linkedIds(id: string): Iterable<string>
}
export function revalidationLinks(findings: Iterable<unknown>): string[][]
