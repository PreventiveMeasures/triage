import { parseToml } from '@preventive/lockfile/toml.js'
import { reportRepoGithub } from '@preventive/report'

function readManifest(files, name) {
  const text = files?.[name]
  if (typeof text !== 'string') return null
  try { return name.endsWith('.toml') ? parseToml(text) : JSON.parse(text) } catch { return null }
}

function githubRepository(value, shorthand = false) {
  const url = typeof value === 'string' ? value : value?.url
  if (typeof url !== 'string') return null
  const github = url.trim().replace(/#.*$/su, '')
    .replace(/^github:/iu, '')
    .replace(/^git\+/iu, '')
    .replace(/^(?:ssh|git):\/\/(?:git@)?github\.com\//iu, 'https://github.com/')
    .replace(/^git@github\.com:/iu, 'https://github.com/')
  if (!/^(?:https?:\/\/)?(?:www\.)?github\.com\//iu.test(github)
      && !(shorthand && /^[\w-]+\/[\w.-]+$/u.test(github))) return null
  return reportRepoGithub({ repo: { github } })
}

// Read only captured package metadata; never fetch a registry on hover or
// borrow the application's repository for one of its dependencies.
export function bundleSourcePackageInfo(pkg, info, fileCount) {
  const ecosystem = info?.ecosystem ?? pkg.ecosystem ?? 'npm'
  const manifest = ecosystem === 'composer'
    ? readManifest(info?.files, 'composer.json')
    : ecosystem === 'cargo'
      ? readManifest(info?.files, 'Cargo.toml')?.package
      : readManifest(info?.files, 'package.json')
  const name = info?.name ?? pkg.name
  const version = info?.version ?? pkg.version ?? manifest?.version
  const github = githubRepository(manifest?.repository, ecosystem === 'npm' || ecosystem === 'soldeer')
    ?? [manifest?.support?.source, manifest?.source?.url, manifest?.homepage, manifest?.bugs]
      .map(value => githubRepository(value)).find(Boolean) ?? null
  return { ecosystem, name, version: typeof version === 'string' ? version : undefined, github, fileCount }
}
