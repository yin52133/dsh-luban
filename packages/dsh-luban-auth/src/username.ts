const USERNAME_CHARACTERS = /^[\p{L}\p{N}\p{M} ._-]+$/u
const RESERVED_NAMES = new Set([
  '.',
  '..',
  ...Object.getOwnPropertyNames(Object.prototype).map((name) => name.toLowerCase()),
])

export const USERNAME_HINT =
  '1–64 个字符，支持中文、字母、数字、空格、点、短横线和下划线；忽略首尾空格和字母大小写。'

/** Use one canonical identity for forms, authentication, and local recovery. */
export function normalizeUsername(value: string): string {
  const normalized = value.trim().normalize('NFC').toLowerCase()
  if (
    Array.from(normalized).length > 64 ||
    !USERNAME_CHARACTERS.test(normalized) ||
    RESERVED_NAMES.has(normalized)
  ) {
    throw new TypeError(
      `用户名不符合要求。${USERNAME_HINT} 不能使用路径字符、控制字符或系统保留名称。`,
    )
  }
  return normalized
}
