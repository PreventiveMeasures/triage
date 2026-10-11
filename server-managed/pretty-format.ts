// Formatting a file and checking the copy: oxfmt, changing what is written no
// more than layout needs, its output checked apart from it to differ from the
// file in layout alone (sameCode). What pretty-print.ts serves, and what a
// rename diff formats (rename-diff.ts).
import { format } from 'oxfmt'

// How files are formatted: changing what is written no more than layout
// needs, so a copy reads as the file does (sameCode). Keys keep their
// quotes, no trailing commas or arrow parameters' parentheses are added, and
// template literals' contents are left as they are, as formatting what they
// hold would change their strings.
export const PRETTY_OPTIONS = {
  quoteProps: 'preserve', trailingComma: 'none', arrowParens: 'avoid', embeddedLanguageFormatting: 'off',
} as const

// A number literal, outside an identifier.
const NUMBER = /(?<![\p{L}\p{N}_$])(?:0[box][\d_a-f]+n?|\d[\d_]*(?:\.[\d_]*)?(?:e[+-]?\d+)?n?)|(?<![\p{N}.])\.\d[\d_]*(?:e[+-]?\d+)?/giu

// A number literal spelled as the formatter spells it: in lowercase, with a
// leading zero, and no `+`, leading zeros or zero exponent, nor trailing zeros
// or dot in its fraction.
function numberSpelling(literal: string): string {
  const number = literal.toLowerCase()
  const parts = /^0[box]|n$/u.test(number) ? null : /^([^e]*)(?:e([+-]?)0*(\d+))?$/u.exec(number)
  if (!parts) return number
  const [, mantissa = '', sign = '', exponent = ''] = parts
  const fraction = (mantissa.startsWith('.') ? `0${mantissa}` : mantissa).replace(/(\.\d*?)0+$/u, '$1').replace(/\.$/u, '')
  return exponent === '' || /^0+$/u.test(exponent) ? fraction : `${fraction}e${sign === '-' ? '-' : ''}${exponent}`
}

// The text in one form, which formatting leaves as it is: numbers spelled
// alike, strings in double quotes with no quote escaped, regular expressions'
// flags in order, and without whitespace, parentheses or semicolons, all of
// which formatting may add or drop. CSS goes without quotes, which formatting
// adds to attribute selectors' values, and in lowercase, as it may lowercase
// keywords.
function codeForm(text: string, css: boolean): string {
  const form = text.replaceAll(NUMBER, numberSpelling).replaceAll(/\\(?=["'])|[\s();]/gu, '').replaceAll("'", '"')
    .replaceAll(/(?<=\/)[dgimsuvy]{2,}(?![\p{L}\p{N}_$])/gu, flags => [...flags].toSorted().join(''))
  return css ? form.replaceAll('"', '').toLowerCase() : form
}

// Whether `formatted` is `text` but for its layout: a quick check, apart from
// the formatter, that it lost or changed nothing else.
export function sameCode(text: string, formatted: string, css = false): boolean {
  return codeForm(text, css) === codeForm(formatted, css)
}

// The text formatted as a file with `extension`, and checked: an error where
// it does not parse, or where the copy would change more than its layout.
export async function formatChecked(text: string, extension: string): Promise<{ code: string } | { error: 'unformattable' | 'pretty-mismatch' }> {
  let result: Awaited<ReturnType<typeof format>>
  try { result = await format(`pretty.${extension}`, text, PRETTY_OPTIONS) }
  catch { return { error: 'unformattable' } }
  if (result.errors.length > 0) return { error: 'unformattable' }
  return sameCode(text, result.code, extension === 'css') ? { code: result.code } : { error: 'pretty-mismatch' }
}
