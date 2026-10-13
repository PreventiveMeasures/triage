export function computeBundleDiff(base: Map<string, unknown>, other: Map<string, unknown>, pkgOf: (path: string) => string, layout?: import('@preventive/compare').Layout): {
  files: { onlyBase: { path: string; basePath?: string }[]; onlyOther: { path: string }[]; changed: { path: string; basePath?: string; renamedFrom?: string }[] }
}
