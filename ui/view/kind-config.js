// The `kind`-discriminated components' render-time lookup: a missing or
// mistyped `kind` warns with the accepted values rather than silently
// rendering nothing. Returns the config, or undefined.
export function kindConfig(tag, table, kind) {
  const config = table[kind]
  if (!config) {
    console.warn(`<${tag}>: unknown kind ${JSON.stringify(kind)}; ` +
      `expected one of ${Object.keys(table).map((k) => JSON.stringify(k)).join(', ')}.`)
  }
  return config
}
