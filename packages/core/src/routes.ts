export const LUBAN_MODULES = [
  'auth',
  'taskboard',
  'keepalive',
  'plan',
  'session-share',
  'image-paste',
  'hud',
  'context',
  'server-mode',
  'win-debug',
  'browser',
] as const

export type LubanModule = (typeof LUBAN_MODULES)[number]

export function modulePrefix(module: LubanModule): `/luban-${LubanModule}` {
  return `/luban-${module}`
}

export function moduleRoute(module: LubanModule, path = ''): string {
  const suffix = path === '' ? '' : `/${path.replace(/^\/+/, '')}`
  return `${modulePrefix(module)}${suffix}`
}

export const AUTH_ROUTES = Object.freeze({
  root: modulePrefix('auth'),
  login: moduleRoute('auth', 'login'),
  logout: moduleRoute('auth', 'logout'),
  session: moduleRoute('auth', 'session'),
})
