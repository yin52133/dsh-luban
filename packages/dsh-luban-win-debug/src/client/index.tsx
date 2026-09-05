import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import {
  csrfHeaders,
  registerWorkbenchPage,
  type WorkbenchPageProps,
} from '@yin52133/dsh-luban-core/client'
import type { FormEvent, ReactNode } from 'react'
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'

interface UiEndpoint {
  readonly kind: string
  readonly id: string
  readonly label: string
  readonly params: Readonly<Record<string, string>>
}

interface UiChannel {
  readonly id: string
  readonly endpoint: UiEndpoint
  readonly openedAt: number
}

interface UiLine {
  readonly sequence: number
  readonly channelId: string
  readonly text: string
  readonly at: number
}

interface UiTemplate {
  readonly id: string
  readonly title: string
  readonly destructive?: boolean
  readonly confirmation?: string
}

interface UiDevice {
  readonly transport: string
  readonly id: string
  readonly state: string
}

interface UiOutputLine {
  readonly level: 'info' | 'warning' | 'error'
  readonly text: string
}

const STYLE = `
.luban-debug{display:grid;gap:12px;color:var(--lb-text,#172033);min-width:0}.luban-debug h2,.luban-debug h3{margin:0}
.luban-debug__grid{display:grid;grid-template-columns:minmax(230px,320px) minmax(0,1fr);gap:12px}.luban-debug__panel{border:1px solid var(--lb-border,#cbd5e1);border-radius:8px;background:var(--lb-bg,#f8fafc);padding:10px;display:grid;gap:8px;align-content:start}
.luban-debug__row{display:flex;gap:7px;flex-wrap:wrap;align-items:center}.luban-debug input,.luban-debug select,.luban-debug textarea,.luban-debug button{font:inherit;border:1px solid var(--lb-border,#cbd5e1);border-radius:6px;padding:7px 9px;background:var(--lb-panel,#fff);color:inherit;min-width:0}.luban-debug button{cursor:pointer;background:#1d4ed8;color:#fff;border-color:#2563eb}.luban-debug button:disabled{opacity:.55}.luban-debug textarea{width:100%;min-height:70px;resize:vertical}
.luban-debug__log{height:440px;overflow:auto;background:var(--lb-bg,#f8fafc);border:1px solid var(--lb-border,#cbd5e1);border-radius:6px;padding:8px;font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap}.luban-debug__line{color:var(--lb-text,#172033)!important;display:block;width:100%;text-align:left;background:transparent!important;border:0!important;padding:1px 3px!important}.luban-debug__line[data-selected=true]{background:var(--lb-selected,#dbeafe)!important}.luban-debug__time{color:var(--lb-muted,#526177);margin-right:8px}.luban-debug mark{background:#f59e0b;color:#172033}.luban-debug__error{color:var(--lb-error,#b91c1c);white-space:pre-wrap}.luban-debug__ok{color:var(--lb-success,#166534)}.luban-debug__device{border-radius:999px;background:var(--lb-panel,#fff);padding:3px 8px}.luban-debug__device[data-bad=true]{color:var(--lb-error,#b91c1c)}.luban-debug__meta{font-size:12px;color:var(--lb-muted,#526177);overflow-wrap:anywhere}
.luban-debug__result-line{font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace}.luban-debug__result-line[data-level=error]{color:var(--lb-error,#b91c1c);font-weight:700}.luban-debug__result-line[data-level=warning]{color:var(--lb-warning,#854d0e)}
@media(max-width:850px){.luban-debug__grid{grid-template-columns:1fr}.luban-debug__log{height:55vh}.luban-debug__row>*{flex:1 1 140px}}
`

async function api(path: string, init?: RequestInit): Promise<unknown> {
  const writing = init?.method !== undefined && init.method !== 'GET'
  const headers = new Headers(init?.headers)
  headers.set('accept', 'application/json')
  if (writing) {
    headers.set('content-type', 'application/json')
    for (const [key, value] of Object.entries(await csrfHeaders())) headers.set(key, value)
  }
  const response = await fetch(`/luban-win-debug${path}`, {
    ...init,
    headers,
  })
  const text = await response.text()
  if (!response.ok)
    throw new Error(text === '' ? `Request failed (${String(response.status)})` : text)
  return text === '' ? {} : (JSON.parse(text) as unknown)
}

function rows<Value>(value: unknown, key: string): Value[] {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid API response')
  const list = (value as Readonly<Record<string, unknown>>)[key]
  if (!Array.isArray(list)) throw new Error('Invalid API response')
  return list as Value[]
}

function highlighted(text: string, query: string, regex: boolean): ReactNode {
  if (query === '') return text
  try {
    if (regex && !safeUiRegex(query)) return text
    const pattern = regex
      ? new RegExp(`(${query})`, 'giu')
      : new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')})`, 'giu')
    return text
      .split(pattern)
      .map((part, index): ReactNode =>
        index % 2 === 1 ? (
          <mark key={`${String(index)}-${part}`}>{part}</mark>
        ) : (
          <Fragment key={`${String(index)}-${part}`}>{part}</Fragment>
        ),
      )
  } catch {
    return text
  }
}

function safeUiRegex(query: string): boolean {
  return (
    query.length <= 256 && !/\([^)]*[+*][^)]*\)[+*{]/u.test(query) && !/\.[+*].*\.[+*]/u.test(query)
  )
}

function jsonStringMap(value: string): Readonly<Record<string, string>> {
  const parsed = JSON.parse(value) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new Error('Params must be a JSON object')
  const row = parsed as Readonly<Record<string, unknown>>
  if (!Object.values(row).every((item): item is string => typeof item === 'string'))
    throw new Error('Every template param must be a string')
  return row as Readonly<Record<string, string>>
}

export function WinDebugSection(_props: WorkbenchPageProps): ReactNode {
  const [endpoints, setEndpoints] = useState<UiEndpoint[]>([])
  const [channels, setChannels] = useState<UiChannel[]>([])
  const [templates, setTemplates] = useState<UiTemplate[]>([])
  const [devices, setDevices] = useState<UiDevice[]>([])
  const [endpointId, setEndpointId] = useState('')
  const [channelId, setChannelId] = useState('')
  const [baudRate, setBaudRate] = useState('115200')
  const [lines, setLines] = useState<UiLine[]>([])
  const [filter, setFilter] = useState('')
  const [regex, setRegex] = useState(false)
  const [follow, setFollow] = useState(true)
  const [selection, setSelection] = useState<readonly [number, number] | null>(null)
  const [sessionId, setSessionId] = useState('')
  const [input, setInput] = useState('')
  const [templateId, setTemplateId] = useState('')
  const [templateParams, setTemplateParams] = useState('{}')
  const [confirmation, setConfirmation] = useState('')
  const [gdbInterface, setGdbInterface] = useState('')
  const [gdbTarget, setGdbTarget] = useState('')
  const [gdbExecutable, setGdbExecutable] = useState('')
  const [mcpState, setMcpState] = useState('unknown')
  const [result, setResult] = useState('')
  const [toolLines, setToolLines] = useState<UiOutputLine[]>([])
  const [error, setError] = useState('')
  const logRef = useRef<HTMLDivElement>(null)

  const refresh = useCallback(async (): Promise<void> => {
    const [endpointBody, channelBody, templateBody, deviceBody, mcpBody] = await Promise.all([
      api('/endpoints'),
      api('/channels'),
      api('/templates'),
      api('/android/devices'),
      api('/desktop-mcp'),
    ])
    const nextEndpoints = rows<UiEndpoint>(endpointBody, 'endpoints')
    const nextChannels = rows<UiChannel>(channelBody, 'channels')
    const nextTemplates = rows<UiTemplate>(templateBody, 'templates')
    const nextDevices = rows<UiDevice>(deviceBody, 'devices')
    setEndpoints(nextEndpoints)
    setChannels(nextChannels)
    setTemplates(nextTemplates)
    setDevices(nextDevices)
    setEndpointId((current): string => (current === '' ? (nextEndpoints[0]?.id ?? '') : current))
    setChannelId((current): string => (current === '' ? (nextChannels[0]?.id ?? '') : current))
    setTemplateId((current): string => (current === '' ? (nextTemplates[0]?.id ?? '') : current))
    if (typeof mcpBody === 'object' && mcpBody !== null) {
      const status = (mcpBody as Readonly<Record<string, unknown>>).status
      if (typeof status === 'object' && status !== null) {
        const state = (status as Readonly<Record<string, unknown>>).state
        if (typeof state === 'string') setMcpState(state)
      }
    }
  }, [])

  const refreshLogs = useCallback(async (): Promise<void> => {
    if (channelId === '') {
      setLines([])
      return
    }
    const value = await api(`/channels/${encodeURIComponent(channelId)}/logs`)
    setLines(rows<UiLine>(value, 'lines'))
  }, [channelId])

  useEffect(() => {
    void refresh().catch((reason: unknown): void =>
      setError(reason instanceof Error ? reason.message : 'Unable to load debug state'),
    )
    const events = new EventSource('/luban-win-debug/events')
    events.addEventListener('win-debug', (raw: Event): void => {
      try {
        const event = JSON.parse((raw as MessageEvent<string>).data) as Readonly<
          Record<string, unknown>
        >
        if (event.type === 'line') {
          const line = event.line as UiLine
          if (line.channelId === channelId)
            setLines((current): UiLine[] => [...current.slice(-499), line])
        } else if (event.type === 'endpoints-changed' || event.type === 'resync') {
          void Promise.all([refresh(), refreshLogs()]).catch((reason: unknown): void =>
            setError(reason instanceof Error ? reason.message : '无法刷新设备状态，请重试'),
          )
        }
      } catch {
        setError('Live debug event was invalid')
      }
    })
    events.onerror = (): void => setError('Live debug stream disconnected; retrying')
    return (): void => events.close()
  }, [channelId, refresh, refreshLogs])

  useEffect(() => {
    void refreshLogs().catch((reason: unknown): void =>
      setError(reason instanceof Error ? reason.message : '无法加载设备日志，请重试'),
    )
  }, [refreshLogs])
  useEffect(() => {
    if (follow && logRef.current !== null) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [follow, lines])

  const visibleLines = useMemo((): readonly UiLine[] => {
    if (filter === '') return lines
    try {
      const pattern = regex && safeUiRegex(filter) ? new RegExp(filter, 'iu') : undefined
      if (regex && pattern === undefined) return lines
      return lines.filter(
        (line): boolean =>
          pattern?.test(line.text) ??
          line.text.toLocaleLowerCase().includes(filter.toLocaleLowerCase()),
      )
    } catch {
      return lines
    }
  }, [filter, lines, regex])

  const act = async (operation: () => Promise<void>): Promise<void> => {
    setError('')
    setResult('')
    setToolLines([])
    try {
      await operation()
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : 'Operation failed')
    }
  }

  const openChannel = async (): Promise<void> => {
    const value = await api('/channels/open', {
      method: 'POST',
      body: JSON.stringify({ endpointId, baudRate: Number(baudRate) }),
    })
    if (typeof value === 'object' && value !== null) {
      const channel = (value as Readonly<Record<string, unknown>>).channel as UiChannel
      setChannelId(channel.id)
      setSelection(null)
      await refresh()
    }
  }

  const submitInput = async (mode: 'write' | 'exec'): Promise<void> => {
    const body = mode === 'write' ? { data: input } : { command: input }
    const value = await api(`/channels/${encodeURIComponent(channelId)}/${mode}`, {
      method: 'POST',
      body: JSON.stringify(body),
    })
    setResult(JSON.stringify(value, null, 2))
    setInput('')
  }

  const capture = async (): Promise<void> => {
    if (selection === null) throw new Error('Select one or more log lines first')
    const value = await api(`/channels/${encodeURIComponent(channelId)}/capture`, {
      method: 'POST',
      body: JSON.stringify({
        from: selection[0],
        to: selection[1],
        ...(sessionId === '' ? {} : { sessionId }),
      }),
    })
    setResult(JSON.stringify(value, null, 2))
  }

  const chooseLine = (sequence: number): void =>
    setSelection((current): readonly [number, number] =>
      current === null
        ? [sequence, sequence]
        : [Math.min(current[0], sequence), Math.max(current[1], sequence)],
    )

  const runTemplate = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const value = await api(`/templates/${encodeURIComponent(templateId)}/run`, {
      method: 'POST',
      body: JSON.stringify({
        params: jsonStringMap(templateParams),
        ...(confirmation === '' ? {} : { confirmation }),
        ...(sessionId === '' ? {} : { sessionId }),
      }),
    })
    if (typeof value === 'object' && value !== null) {
      const runResult = (value as Readonly<Record<string, unknown>>).result
      if (typeof runResult === 'object' && runResult !== null) {
        const lines = (runResult as Readonly<Record<string, unknown>>).lines
        if (Array.isArray(lines)) setToolLines(lines as UiOutputLine[])
      }
    }
    setResult(JSON.stringify(value, null, 2))
  }

  return (
    <section className="luban-debug" aria-label="Luban Windows debug">
      <style>{STYLE}</style>
      <div className="luban-debug__grid">
        <aside className="luban-debug__panel">
          <h3>设备通道</h3>
          <select
            aria-label="设备端点"
            value={endpointId}
            onChange={(event): void => setEndpointId(event.currentTarget.value)}
          >
            {endpoints.map((endpoint) => (
              <option key={endpoint.id} value={endpoint.id}>
                {endpoint.label} [{endpoint.kind}]
              </option>
            ))}
          </select>
          <div className="luban-debug__row">
            <input
              aria-label="波特率"
              value={baudRate}
              onChange={(event): void => setBaudRate(event.currentTarget.value)}
            />
            <button
              disabled={endpointId === ''}
              type="button"
              onClick={(): void => {
                void act(openChannel)
              }}
            >
              打开通道
            </button>
          </div>
          <select
            aria-label="当前通道"
            value={channelId}
            onChange={(event): void => {
              setChannelId(event.currentTarget.value)
              setSelection(null)
            }}
          >
            <option value="">未打开通道</option>
            {channels.map((channel) => (
              <option key={channel.id} value={channel.id}>
                {channel.endpoint.label}
              </option>
            ))}
          </select>
          <div className="luban-debug__row">
            <button
              disabled={channelId === ''}
              type="button"
              onClick={(): void => {
                void act(async (): Promise<void> => {
                  await api(`/channels/${encodeURIComponent(channelId)}/close`, {
                    method: 'POST',
                    body: '{}',
                  })
                  setChannelId('')
                  await refresh()
                })
              }}
            >
              关闭通道
            </button>
            <button
              type="button"
              onClick={(): void => {
                void act(refresh)
              }}
            >
              刷新
            </button>
          </div>
          <h3>输入与命令</h3>
          <textarea
            aria-label="输入与命令"
            value={input}
            onChange={(event): void => setInput(event.currentTarget.value)}
          />
          <div className="luban-debug__row">
            <button
              disabled={channelId === '' || input === ''}
              type="button"
              onClick={(): void => {
                void act(async (): Promise<void> => submitInput('write'))
              }}
            >
              发送
            </button>
            <button
              disabled={channelId === '' || input === ''}
              type="button"
              onClick={(): void => {
                void act(async (): Promise<void> => submitInput('exec'))
              }}
            >
              执行命令
            </button>
          </div>
          <h3>截取日志到对话</h3>
          <input
            placeholder="对话 ID（可选）"
            value={sessionId}
            onChange={(event): void => setSessionId(event.currentTarget.value)}
          />
          <button
            disabled={selection === null}
            type="button"
            onClick={(): void => {
              void act(capture)
            }}
          >
            保存{sessionId === '' ? '' : '并发送到对话'}{' '}
            {selection === null ? '' : `${String(selection[0])}–${String(selection[1])}`}
          </button>
        </aside>
        <main className="luban-debug__panel">
          <div className="luban-debug__row">
            <input
              placeholder="筛选与高亮"
              value={filter}
              onChange={(event): void => setFilter(event.currentTarget.value)}
            />
            <label>
              <input
                type="checkbox"
                checked={regex}
                onChange={(event): void => setRegex(event.currentTarget.checked)}
              />{' '}
              正则表达式
            </label>
            <label>
              <input
                type="checkbox"
                checked={follow}
                onChange={(event): void => setFollow(event.currentTarget.checked)}
              />{' '}
              跟随最新日志
            </label>
          </div>
          <div className="luban-debug__log" ref={logRef}>
            {visibleLines.map((line) => (
              <button
                className="luban-debug__line"
                data-selected={
                  selection !== null &&
                  line.sequence >= selection[0] &&
                  line.sequence <= selection[1]
                }
                key={line.sequence}
                type="button"
                onClick={(): void => chooseLine(line.sequence)}
              >
                <span className="luban-debug__time">{new Date(line.at).toLocaleTimeString()}</span>
                {highlighted(line.text, filter, regex)}
              </button>
            ))}
          </div>
        </main>
      </div>
      <div className="luban-debug__grid">
        <form
          className="luban-debug__panel"
          onSubmit={(event): void => {
            void act(async (): Promise<void> => runTemplate(event))
          }}
        >
          <h3>烧录与复位模板</h3>
          <select
            value={templateId}
            onChange={(event): void => setTemplateId(event.currentTarget.value)}
          >
            {templates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.title}
                {template.destructive === true ? ' ⚠' : ''}
              </option>
            ))}
          </select>
          <textarea
            aria-label="模板参数（JSON）"
            value={templateParams}
            onChange={(event): void => setTemplateParams(event.currentTarget.value)}
          />
          <input
            placeholder="高风险模板的确认短语"
            value={confirmation}
            onChange={(event): void => setConfirmation(event.currentTarget.value)}
          />
          <button type="submit" disabled={templateId === ''}>
            {sessionId === '' ? '运行模板' : '运行并发送到对话'}
          </button>
          {templates.length === 0 ? (
            <p className="luban-debug__meta">尚未配置可用模板，请联系主机管理员配置后刷新。</p>
          ) : null}
          {toolLines.map((line, index) => (
            <div
              className="luban-debug__result-line"
              data-level={line.level}
              key={`${String(index)}-${line.text}`}
            >
              {line.text}
            </div>
          ))}
        </form>
        <section className="luban-debug__panel">
          <h3>adb / fastboot</h3>
          <div className="luban-debug__row">
            {devices.length === 0 ? (
              <span className="luban-debug__meta">未检测到设备，请检查连接和驱动</span>
            ) : (
              devices.map((device) => (
                <span
                  className="luban-debug__device"
                  data-bad={device.state === 'offline' || device.state === 'unauthorized'}
                  key={`${device.transport}:${device.id}`}
                >
                  {device.transport} {device.id}: {device.state}
                </span>
              ))
            )}
          </div>
        </section>
      </div>
      <div className="luban-debug__grid">
        <section className="luban-debug__panel">
          <h3>OpenOCD + GDB snapshots</h3>
          <input
            placeholder="Interface config path"
            value={gdbInterface}
            onChange={(event): void => setGdbInterface(event.currentTarget.value)}
          />
          <input
            placeholder="Target config path"
            value={gdbTarget}
            onChange={(event): void => setGdbTarget(event.currentTarget.value)}
          />
          <div className="luban-debug__row">
            <button
              type="button"
              onClick={(): void => {
                void act(async (): Promise<void> => {
                  setResult(
                    JSON.stringify(
                      await api('/gdb/start', {
                        method: 'POST',
                        body: JSON.stringify({
                          interfaceConfig: gdbInterface,
                          targetConfig: gdbTarget,
                        }),
                      }),
                      null,
                      2,
                    ),
                  )
                })
              }}
            >
              Start
            </button>
            <button
              type="button"
              onClick={(): void => {
                void act(async (): Promise<void> => {
                  setResult(
                    JSON.stringify(await api('/gdb/stop', { method: 'POST', body: '{}' }), null, 2),
                  )
                })
              }}
            >
              Stop
            </button>
          </div>
          <input
            placeholder="ELF executable path"
            value={gdbExecutable}
            onChange={(event): void => setGdbExecutable(event.currentTarget.value)}
          />
          <button
            type="button"
            onClick={(): void => {
              void act(async (): Promise<void> => {
                setResult(
                  JSON.stringify(
                    await api('/gdb/snapshot', {
                      method: 'POST',
                      body: JSON.stringify({
                        executable: gdbExecutable,
                        registers: true,
                        ...(sessionId === '' ? {} : { sessionId }),
                      }),
                    }),
                    null,
                    2,
                  ),
                )
              })
            }}
          >
            Snapshot registers/backtrace
          </button>
        </section>
        <section className="luban-debug__panel">
          <h3>Desktop MCP</h3>
          <div className="luban-debug__meta">
            State: {mcpState}. Command and tool allowlist come only from local profile config.
          </div>
          <div className="luban-debug__row">
            <button
              type="button"
              onClick={(): void => {
                void act(async (): Promise<void> => {
                  const value = await api('/desktop-mcp/start', { method: 'POST', body: '{}' })
                  setResult(JSON.stringify(value, null, 2))
                  setMcpState('running')
                })
              }}
            >
              Start
            </button>
            <button
              type="button"
              onClick={(): void => {
                void act(async (): Promise<void> => {
                  const value = await api('/desktop-mcp/stop', { method: 'POST', body: '{}' })
                  setResult(JSON.stringify(value, null, 2))
                  setMcpState('stopped')
                })
              }}
            >
              Stop
            </button>
          </div>
        </section>
      </div>
      {error === '' ? null : (
        <div className="luban-debug__error" role="alert">
          {error}
        </div>
      )}
      {result === '' ? null : <pre className="luban-debug__meta">{result}</pre>}
    </section>
  )
}

export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  registerWorkbenchPage(ctx, {
    id: 'luban-win-debug',
    title: '设备调试',
    group: '工具',
    order: 60,
    description: '在 Windows 主机使用串口、日志片段和调试工具。',
    component: WinDebugSection,
  })
}
