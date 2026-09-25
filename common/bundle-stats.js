import { langForPath } from './code-language.js'

const BUNDLE_LANGUAGE_LABELS = Object.freeze({
  javascript: 'JavaScript', jsx: 'JSX', typescript: 'TypeScript', tsx: 'TSX',
  json: 'JSON', css: 'CSS', markup: 'HTML', yaml: 'YAML', bash: 'Shell',
  markdown: 'Markdown', solidity: 'Solidity', php: 'PHP', rust: 'Rust',
  ruby: 'Ruby', java: 'Java', cpp: 'C++', c: 'C', objectivec: 'Objective-C',
  python: 'Python', go: 'Go', kotlin: 'Kotlin', swift: 'Swift', dart: 'Dart',
  sql: 'SQL', lua: 'Lua', csharp: 'C#', scala: 'Scala', vue: 'Vue', svelte: 'Svelte',
})
const BUNDLE_EXTENSION_LANGUAGES = Object.freeze({
  py: 'python', pyw: 'python', go: 'go', kt: 'kotlin', kts: 'kotlin', swift: 'swift',
  dart: 'dart', sql: 'sql', lua: 'lua', cs: 'csharp', scala: 'scala', sc: 'scala',
  vue: 'vue', svelte: 'svelte',
})

function bundleLanguageOf(path) {
  const basename = typeof path === 'string' ? path.slice(path.lastIndexOf('/') + 1) : ''
  const dot = basename.lastIndexOf('.')
  const ext = dot > 0 ? basename.slice(dot + 1).trim().toLowerCase() : ''
  const lang = langForPath(path) ?? BUNDLE_EXTENSION_LANGUAGES[ext]
  if (lang) return { key: lang, label: BUNDLE_LANGUAGE_LABELS[lang] ?? lang }
  return ext ? { key: `extension:${ext}`, label: `.${ext}` } : { key: 'other', label: 'Other' }
}

export function bundleCodeStats(lineCounts, fileSizes) {
  const languages = new Map()
  let bytes = 0, lines = 0
  for (const [path, count] of lineCounts) {
    const language = bundleLanguageOf(path)
    const stat = languages.get(language.key) ?? { ...language, files: 0, lines: 0, bytes: 0 }
    stat.files++
    stat.lines += count
    stat.bytes += fileSizes.get(path) ?? 0
    languages.set(language.key, stat)
    lines += count
    bytes += fileSizes.get(path) ?? 0
  }
  return { files: lineCounts.size, lines, bytes, languages: [...languages.values()]
    .toSorted((a, b) => b.lines - a.lines || a.label.localeCompare(b.label)) }
}
