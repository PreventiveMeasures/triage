// Loaded only when a Markdown details section is opened.
import MarkdownIt from 'markdown-it'

const markdown = new MarkdownIt({ html: false, linkify: true })

function resolveUrl(token, attribute, baseUrl) {
  const value = token.attrGet(attribute)
  token.attrs = token.attrs.filter(([name]) => name !== attribute && name !== 'title')
  try {
    const url = new URL(value, baseUrl || undefined)
    if (['http:', 'https:'].includes(url.protocol) || (attribute === 'href' && url.protocol === 'mailto:')) token.attrSet(attribute, url.href)
  } catch { /* Unresolvable relative links stay inert. */ }
}

markdown.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
  const token = tokens[index]
  resolveUrl(token, 'href', env.baseUrl)
  token.attrSet('target', '_blank')
  token.attrSet('rel', 'noopener noreferrer')
  return renderer.renderToken(tokens, index, options)
}
markdown.renderer.rules.image = (tokens, index, options, env, renderer) => {
  const token = tokens[index]
  resolveUrl(token, 'src', env.baseUrl)
  const url = token.attrGet('src')
  const label = markdown.utils.escapeHtml(renderer.renderInlineAsText(token.children, options, env) || 'Image')
  // The viewer permits only same-origin images. Keep advisory illustrations
  // accessible as links instead of showing broken images or loading trackers.
  return url ? `<a href="${markdown.utils.escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${label}</a>` : label
}

export function renderMarkdown(text, baseUrl) {
  return markdown.render(text, { baseUrl })
}
