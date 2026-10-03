// Names can cross Prism token boundaries (notably Rust's `crate::module::Type`).
// Keep offsets into the original source while excluding comments, literals,
// variables, and markup outside PHP blocks from identifier matching.
function nameSource(tokens, code) {
  if (typeof tokens === 'string') return code ? tokens : '\0'.repeat(tokens.length)
  if (Array.isArray(tokens)) return tokens.map(token => nameSource(token, code)).join('')
  const excluded = /comment|string|char|variable|lifetime|definition/u.test(tokens.type)
  return nameSource(tokens.content, !excluded && (code || tokens.type === 'php'))
}

export function sourceNameLinks(tokens, language, resolve) {
  if (!resolve || !['php', 'rust'].includes(language)) return []
  const source = nameSource(tokens, language === 'rust')
  if (language === 'rust') return rustLinks(source, resolve)
  // Namespace separators belong to the name, not its delimiters. An optional
  // leading separator is accepted, but suffixes of a longer name never match.
  const pattern = /(?<![$\\\w\u0080-\u{10FFFF}])\\?[a-zA-Z_\u0080-\u{10FFFF}][\w\u0080-\u{10FFFF}]*(?:\\[a-zA-Z_\u0080-\u{10FFFF}][\w\u0080-\u{10FFFF}]*)*(?![\\\w\u0080-\u{10FFFF}])/gu
  const links = []
  for (const match of source.matchAll(pattern)) {
    const target = resolve(match[0].replace(/^\\/u, ''))
    if (target) links.push({ start: match.index, end: match.index + match[0].length, target })
  }
  return links
}

function rustLinks(source, resolve) {
  const pattern = /(?<![$#\p{XID_Continue}])(?<!::)(?:(?:use|extern|as|mod)(?![\p{XID_Continue}])|(?:::)?(?:r#)?[_\p{XID_Start}][_\p{XID_Continue}]*(?:\s*::\s*(?:r#)?[_\p{XID_Start}][_\p{XID_Continue}]*)*(?![#\p{XID_Continue}]))|[{};,]/gu
  const links = []
  let importing = false
  let alias = false
  let prefix = ''
  let pending = ''
  let previous = ''
  let beforePrevious = ''
  let modulePrefix = ''
  let inlineModule = ''
  const groups = []
  const scopes = []
  for (const match of source.matchAll(pattern)) {
    const spelling = match[0]
    const externalRoot = beforePrevious === 'extern' && previous === 'crate'
    const moduleDeclaration = previous === 'mod'
    beforePrevious = previous
    previous = spelling
    if (spelling === 'use' || spelling === ';') {
      importing = spelling === 'use'
      alias = false
      prefix = pending = ''
      inlineModule = ''
      groups.length = 0
      continue
    }
    if (/^[{};,]$/u.test(spelling)) {
      if (spelling === '{') {
        scopes.push(modulePrefix)
        if (inlineModule) modulePrefix += `${inlineModule}::`
      }
      if (spelling === '}') modulePrefix = scopes.pop() ?? ''
      inlineModule = ''
      if (importing && spelling === '{') { groups.push(prefix); prefix = pending ? `${pending}::` : prefix }
      if (importing && spelling === '}') prefix = groups.pop() ?? ''
      pending = ''
      alias = false
      continue
    }
    if (importing && spelling === 'as') { alias = true; continue }
    if (alias) continue
    const name = spelling.replace(/^::/u, '').replaceAll(/\s+|\br#/gu, '')
    inlineModule = moduleDeclaration ? name : ''
    if (moduleDeclaration) {
      // Only out-of-line declarations load another file. Stasis prefixes
      // their keys with the enclosing inline modules, if any.
      const target = /^[\s\0]*;/u.test(source.slice(match.index + spelling.length))
        ? resolve(`mod ${modulePrefix}${name}`) : null
      if (target) links.push({ start: match.index, end: match.index + spelling.length, target })
      continue
    }
    const expanded = prefix && name === 'self' ? prefix.slice(0, -2) : prefix + name
    pending = expanded
    let target = resolve(expanded)
    let length = spelling.length
    if (!target && !prefix) {
      // Stasis records external crate roots as `use <crate>`, including roots
      // used in qualified expressions. Link only the root of such a path.
      const root = name.split('::')[0]
      if (importing || externalRoot || name.includes('::')) {
        target = resolve(`use ${root}`)
        length = (spelling.startsWith('::') ? 2 : 0) + spelling.replace(/^::/u, '').split(/\s*::/u)[0].length
      }
    }
    if (target) links.push({ start: match.index, end: match.index + length, target })
  }
  return links
}
