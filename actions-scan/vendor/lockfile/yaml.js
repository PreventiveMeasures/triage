// The YAML parser the lockfile is read by, on its own: strict, and the
// subset pnpm writes lockfiles in. yaml.d.ts says what it takes.
export { parseYaml, parseYamlStream } from './src/yaml/parse.js'
export { YamlError } from './src/yaml/error.js'
