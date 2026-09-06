// Render-time guard for the `kind`-discriminated components
// (toolbar-search, entity-search, entity-sort, slide-triage-tabs,
// sidebar-view-button): look the host's `kind` up in the component's
// KIND table and, when it's missing, warn with the accepted values so a
// mistyped or absent attribute surfaces in dev rather than silently
// rendering nothing. Returns the config, or undefined.
export function kindConfig(tag, table, kind) {
  const config = table[kind]
  if (!config) {
    console.warn(`<${tag}>: unknown kind ${JSON.stringify(kind)}; ` +
      `expected one of ${Object.keys(table).map((k) => JSON.stringify(k)).join(', ')}.`)
  }
  return config
}
