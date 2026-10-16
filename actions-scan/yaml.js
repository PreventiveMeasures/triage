// The YAML workflows and actions' metadata are written in, read as GitHub
// reads them: @preventive/lockfile's parseYaml with `workflow`, and `lines`
// set to where each block mapping's and sequence's values are
// (PreventiveMeasures/libraries#238). Its files are kept here as they are
// there, in vendor/lockfile/, as of 3074d12, till a release of it reads
// workflows; this then imports '@preventive/lockfile/yaml.js', and vendor/
// goes.
export { YamlError, parseYaml } from './vendor/lockfile/yaml.js'
