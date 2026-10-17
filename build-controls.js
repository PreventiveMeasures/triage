// esbuild prints most C0 control characters in a string as they are, all but
// NUL, BEL, backspace, VT, FF, CR, ESC and DEL, even where the source wrote
// their escape (ui/view/filters.js's `'\u0001'` sentinels, awk's SUBSEP
// `'\u001C'` in @preventive/terminal), and oxc-minify, which minifies its
// output again (build.js), DEL too, so out/ held them raw, which risk tags
// as text that can hide in a file (risk/files/characters.js CONTROLS). Each
// is written back as its escape: minified code holds one only in a string, a
// template or a regular expression, where `\xHH` reads as the character
// itself (a tagged template's raw text aside, which nothing bundled reads of
// one holding a control character).
const RAW_CONTROLS = /[\0-\x08\v\f\x0e-\x1f\x7f]/gu
export const escapedControls = text => text.replace(RAW_CONTROLS, char => `\\x${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)
