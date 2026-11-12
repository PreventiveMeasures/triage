export function ignoresOwnRepo(finding: unknown, reportRepo: unknown): boolean
export function dropForeignRepo<T>(finding: T, reportRepo: unknown): T
export function isStrayRepo(finding: unknown, ours: ReadonlySet<string>): boolean
export function ourRepoSlugs(repos: Iterable<unknown>): Set<string>
export function withoutStrayRepos<T>(data: T, ours: ReadonlySet<string>): T
