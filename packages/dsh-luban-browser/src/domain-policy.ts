/** Return whether a pattern would grant unrestricted host access. */
export function isUnrestrictedDomainPattern(pattern: string): boolean {
  const withoutScheme = pattern
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//u, '')
  const normalized = withoutScheme.split('/')[0]?.split(':')[0]?.replace(/\.$/u, '') ?? ''
  return normalized === '*'
}
