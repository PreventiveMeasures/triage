export function isDependencyFile(file: unknown, directory: string): boolean
export function dependencyDirectory(reports: Iterable<{ groups?: Iterable<Iterable<{ file?: unknown }>>; tree?: unknown }>): 'node_modules' | 'vendor' | 'dependencies'
