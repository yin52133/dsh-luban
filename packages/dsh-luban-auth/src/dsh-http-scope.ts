const DSH_API_ROOT = '/api/'
const SESSION_REFERENCE_SCHEME = 'dsh-session:'

const LEGACY_SESSION_ID_METHODS: ReadonlySet<string> = new Set([
  'session.create',
  'session.history',
  'session.models',
  'session.selectModel',
  'session.rename',
  'session.fork',
  'session.prompt',
  'session.attachment',
  'session.updateQueue',
  'session.cancel',
  'skill.list',
  'agentPreset.select',
  'goal.create',
  'goal.edit',
  'goal.pause',
  'goal.resume',
  'goal.complete',
  'goal.clear',
])

const SUBAGENT_METHODS: ReadonlySet<string> = new Set([
  'subagent.list',
  'subagent.history',
  'subagent.prompt',
  'subagent.interrupt',
])

const TYPERT_AGENT_ID_METHODS: ReadonlySet<string> = new Set([
  'commands/execute',
  'commands/list',
  'fileReferences/list',
  'goals/clear',
  'goals/complete',
  'goals/create',
  'goals/edit',
  'goals/pause',
  'goals/resume',
  'sessionReferenceResolver/candidates',
  'dynamicCordisRunner/getClientCode',
  'dynamicCordisRunner/reportClientGuardFailure',
  'dynamicCordisRunner/reportRenderFailure',
  'dynamicCordisRunner/resolveInspectQuery',
  'dynamicCordisRunner/runHostHalf',
  'dynamicCordisRunner/settleUserRun',
  'dynamicCordisRunner/stopFromPanel',
  'dynamicCordisRunner/undefineFromPanel',
])

const MESSAGE_FEEDBACK_METHODS: ReadonlySet<string> = new Set([
  'messageFeedback/delete',
  'messageFeedback/list',
  'messageFeedback/put',
])

/** Return the complete DSH endpoint after `/api/`, including Typert namespace separators. */
export function dshMethodFromPath(pathname: string): string | undefined {
  if (!pathname.startsWith(DSH_API_ROOT)) return undefined
  const method = pathname.slice(DSH_API_ROOT.length)
  return method === '' ? undefined : method
}

/** Extract only the account-scoped Session ids named by the current DSH rc.2 wire contract. */
export function dshRequestSessionIds(method: string | undefined, message: unknown): string[] {
  if (method === undefined) return []
  const root = asRecord(message)
  if (root === null) return []

  if (method === 'respond') {
    const result = asRecord(root.result)
    const value = asRecord(result?.value)
    return sessionIdValues(value?.sessionId)
  }

  const payload = asRecord(root.payload)
  if (payload === null) return []
  const ids: string[] = []

  if (LEGACY_SESSION_ID_METHODS.has(method)) pushSessionId(ids, payload.sessionId)

  if (method === 'workspace.insertSessionBefore') {
    pushSessionId(ids, payload.sessionId)
    pushSessionId(ids, payload.beforeSessionId)
  } else if (method === 'workspace.archiveSession') {
    pushSessionId(ids, payload.sessionId)
  }

  if (SUBAGENT_METHODS.has(method)) {
    pushSessionId(ids, payload.parentSessionId)
    pushSessionId(ids, payload.childSessionId)
  }

  const args = asRecord(payload.args)
  if (TYPERT_AGENT_ID_METHODS.has(method)) pushSessionId(ids, args?.agentId)

  if (MESSAGE_FEEDBACK_METHODS.has(method)) {
    const request = asRecord(args?.request)
    pushSessionId(ids, request?.sessionId)
  }

  if (method === 'session.prompt') appendPromptReferenceSessionIds(ids, payload.content)
  return ids
}

function appendPromptReferenceSessionIds(ids: string[], content: unknown): void {
  if (!Array.isArray(content)) return
  for (const item of content as readonly unknown[]) {
    const part = asRecord(item)
    if (part?.type !== 'text' || typeof part.text !== 'string') continue
    for (const match of part.text.matchAll(
      /@\[((?:\\.|[^\\\]])*)\]\((dsh-session:[^\s)]*)\)|(dsh-session:[A-Za-z0-9_-]+)/gu,
    )) {
      const uri = match[2] ?? match[3]
      if (uri === undefined) continue
      const sessionId = decodeCanonicalSessionReferenceUri(uri)
      if (sessionId !== null) ids.push(sessionId)
    }
  }
}

function decodeCanonicalSessionReferenceUri(uri: string): string | null {
  if (!uri.startsWith(SESSION_REFERENCE_SCHEME)) return null
  const payload = uri.slice(SESSION_REFERENCE_SCHEME.length)
  if (!/^[A-Za-z0-9_-]+$/u.test(payload)) return null
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown
    if (typeof decoded !== 'string') return null
    return encodeSessionReferenceUri(decoded) === uri ? decoded : null
  } catch {
    // DSH remains responsible for reporting malformed references to its caller.
    return null
  }
}

function encodeSessionReferenceUri(sessionId: string): string {
  const payload = Buffer.from(JSON.stringify(sessionId), 'utf8').toString('base64url')
  return `${SESSION_REFERENCE_SCHEME}${payload}`
}

function pushSessionId(ids: string[], value: unknown): void {
  if (typeof value === 'string' && value !== '') ids.push(value)
}

function sessionIdValues(value: unknown): string[] {
  const ids: string[] = []
  pushSessionId(ids, value)
  return ids
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}
