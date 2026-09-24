// Identify the provider from a distinctive prefix, without validating or
// transmitting the credential. Generic sk- keys belong to several services.
export function detectTokenProvider(value) {
  const token = value.trim()
  if (/^sk-ant-[A-Za-z0-9_-]*$/u.test(token)) return 'anthropic'
  if (/^sk-or-v1-[A-Za-z0-9_-]*$/u.test(token)) return 'openrouter'
  if (/^sk-(?:proj|svcacct)-[A-Za-z0-9_-]*$/u.test(token)) return 'openai'
  return null
}
