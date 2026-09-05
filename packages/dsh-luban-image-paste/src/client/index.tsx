import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import {
  csrfHeaders,
  registerWorkbenchPage,
  type WorkbenchPageProps,
} from '@yin52133/dsh-luban-core/client'
import type { ClipboardEvent, DragEvent, ReactNode } from 'react'
import { useCallback, useEffect, useState } from 'react'

type ImageSource = 'paste' | 'drop'
type InjectStyle = 'markdown' | 'path'

interface UiImage {
  readonly id: string
  readonly relPath: string
  readonly sha256: string
  readonly source: 'paste' | 'drop' | 'clipboard-cli'
  readonly referencedBy: readonly string[]
  readonly createdAt: number
  readonly mime: 'image/png' | 'image/jpeg' | 'image/webp'
  readonly bytes: number
  readonly originalName: string
  readonly compression: {
    readonly status: string
    readonly originalBytes: number
    readonly outputBytes: number
    readonly reason?: string
  }
  readonly previewUrl: string
}

const MAX_BROWSER_BYTES = 10 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 10_000
const MAX_JSON_RESPONSE_BYTES = 1024 * 1024
const ACCEPTED_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp'])

const STYLE = `
.luban-image{display:grid;gap:14px;color:var(--lb-text,#172033);min-width:0}
.luban-image__controls{display:flex;gap:8px;flex-wrap:wrap}.luban-image input,.luban-image select,.luban-image button{font:inherit;border:1px solid var(--lb-border,#cbd5e1);border-radius:6px;padding:8px;background:var(--lb-panel,#fff);color:inherit}
.luban-image button{cursor:pointer;background:#1d4ed8;color:#fff;border-color:#2563eb}.luban-image button:disabled{opacity:.55;cursor:not-allowed}
.luban-image__drop{display:grid;place-items:center;min-height:130px;border:2px dashed var(--lb-muted,#526177);border-radius:10px;background:var(--lb-bg,#f8fafc);padding:18px;text-align:center;outline:none}.luban-image__drop:focus{border-color:#60a5fa}
.luban-image__list{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:10px}.luban-image__card{display:grid;gap:7px;border:1px solid var(--lb-border,#cbd5e1);border-radius:8px;background:var(--lb-bg,#f8fafc);padding:9px;min-width:0}
.luban-image__card img{width:100%;height:150px;object-fit:contain;background:var(--lb-bg,#f8fafc);border-radius:5px}.luban-image__meta{font-size:11px;color:var(--lb-muted,#526177);overflow-wrap:anywhere}.luban-image__error{color:var(--lb-error,#b91c1c);white-space:pre-wrap}.luban-image__ok{color:var(--lb-success,#166534)}
@media(max-width:760px){.luban-image__controls>*{flex:1 1 140px}.luban-image__list{grid-template-columns:1fr}}
`

function isUiImage(value: unknown): value is UiImage {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Readonly<Record<string, unknown>>
  return (
    typeof row.id === 'string' &&
    typeof row.relPath === 'string' &&
    typeof row.sha256 === 'string' &&
    typeof row.createdAt === 'number' &&
    typeof row.mime === 'string' &&
    typeof row.bytes === 'number' &&
    typeof row.previewUrl === 'string' &&
    Array.isArray(row.referencedBy)
  )
}

function imageFrom(value: unknown): UiImage {
  if (typeof value !== 'object' || value === null)
    throw new Error('Image API returned invalid JSON')
  const image = (value as Readonly<Record<string, unknown>>).image
  if (!isUiImage(image)) throw new Error('Image API returned an invalid image')
  return image
}

function imagesFrom(value: unknown): UiImage[] {
  if (typeof value !== 'object' || value === null)
    throw new Error('Image API returned invalid JSON')
  const images = (value as Readonly<Record<string, unknown>>).images
  if (!Array.isArray(images) || !images.every(isUiImage)) {
    throw new Error('Image API returned invalid images')
  }
  return images
}

export function acceptedImageFile(file: File): boolean {
  return (
    ACCEPTED_MIMES.has(file.type.toLowerCase()) && file.size > 0 && file.size <= MAX_BROWSER_BYTES
  )
}

/** Return the first complete browser image that can pass the upload boundary. */
export function selectAcceptedImage(files: Iterable<File>): File | undefined {
  for (const file of files) {
    if (acceptedImageFile(file)) return file
  }
  return undefined
}

async function boundedResponseText(response: Response): Promise<string> {
  const declared = Number.parseInt(response.headers.get('content-length') ?? '', 10)
  if (Number.isFinite(declared) && declared > MAX_JSON_RESPONSE_BYTES) {
    await response.body?.cancel()
    throw new Error('Image API response is too large')
  }
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > MAX_JSON_RESPONSE_BYTES) {
        await reader.cancel()
        throw new Error('Image API response is too large')
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

async function apiError(response: Response, operation: string): Promise<never> {
  await response.body?.cancel()
  throw new Error(`${operation} failed (${String(response.status)})`)
}

async function responseJson(response: Response, operation: string): Promise<unknown> {
  if (!response.ok) return apiError(response, operation)
  const text = await boundedResponseText(response)
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error(`${operation} returned invalid JSON`)
  }
}

async function withDeadline<Value>(
  input: string,
  init: RequestInit,
  operation: string,
  consume: (response: Response) => Promise<Value>,
): Promise<Value> {
  const controller = new AbortController()
  const timeoutError = new Error(`${operation} timed out`)
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject): void => {
    timer = setTimeout((): void => {
      controller.abort()
      reject(timeoutError)
    }, REQUEST_TIMEOUT_MS)
  })
  try {
    const work = fetch(input, { ...init, signal: controller.signal }).then(consume)
    return await Promise.race([work, timeout])
  } catch (error: unknown) {
    if (controller.signal.aborted) throw timeoutError
    throw error
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function requestJson(input: string, init: RequestInit, operation: string): Promise<unknown> {
  return withDeadline(input, init, operation, (response): Promise<unknown> =>
    responseJson(response, operation),
  )
}

function requestOk(input: string, init: RequestInit, operation: string): Promise<void> {
  return withDeadline(input, init, operation, async (response): Promise<void> => {
    if (!response.ok) return apiError(response, operation)
    await response.body?.cancel()
  })
}

/** Upload one browser paste/drop image through the authenticated M06 API. */
export async function uploadImage(file: File, source: ImageSource): Promise<UiImage> {
  if (!acceptedImageFile(file)) throw new Error('Choose a PNG, JPEG, or WebP image up to 10 MB')
  const query = new URLSearchParams({ source, name: file.name || source })
  return imageFrom(
    await requestJson(
      `/luban-image-paste/images?${query.toString()}`,
      {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': file.type,
          ...(await csrfHeaders()),
        },
        body: file,
      },
      'Image upload',
    ),
  )
}

async function injectImage(id: string, sessionId: string, style: InjectStyle): Promise<UiImage> {
  return imageFrom(
    await requestJson(
      `/luban-image-paste/images/${encodeURIComponent(id)}/inject`,
      {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          ...(await csrfHeaders()),
        },
        body: JSON.stringify({ sessionId, style }),
      },
      'Session injection',
    ),
  )
}

async function deleteImage(id: string): Promise<void> {
  return requestOk(
    `/luban-image-paste/images/${encodeURIComponent(id)}`,
    {
      method: 'DELETE',
      headers: { accept: 'application/json', ...(await csrfHeaders()) },
    },
    'Image deletion',
  )
}

async function cleanExpired(): Promise<void> {
  return requestOk(
    '/luban-image-paste/cleanup',
    {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...(await csrfHeaders()),
      },
      body: JSON.stringify({ dryRun: false }),
    },
    'Image cleanup',
  )
}

export function ImagePasteSection(_props: WorkbenchPageProps): ReactNode {
  const [images, setImages] = useState<UiImage[]>([])
  const [sessionId, setSessionId] = useState('')
  const [style, setStyle] = useState<InjectStyle>('markdown')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const refresh = useCallback(async (): Promise<void> => {
    setImages(
      imagesFrom(
        await requestJson(
          '/luban-image-paste/images',
          { headers: { accept: 'application/json' } },
          'Image list',
        ),
      ),
    )
  }, [])

  useEffect(() => {
    void refresh().catch((reason: unknown): void =>
      setError(reason instanceof Error ? reason.message : 'Unable to load recent images'),
    )
  }, [refresh])

  const ingest = async (file: File, source: ImageSource): Promise<void> => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      let image = await uploadImage(file, source)
      if (sessionId.trim() !== '') image = await injectImage(image.id, sessionId.trim(), style)
      setNotice(
        sessionId.trim() === ''
          ? `已保存：${image.relPath}`
          : `已保存并发送到对话：${image.relPath}`,
      )
      await refresh()
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : 'Unable to ingest image')
    } finally {
      setBusy(false)
    }
  }

  const paste = (event: ClipboardEvent<HTMLElement>): void => {
    if (busy) return
    const file = selectAcceptedImage(event.clipboardData.files)
    if (file === undefined) {
      setError('Clipboard does not contain a PNG, JPEG, or WebP image')
      return
    }
    event.preventDefault()
    void ingest(file, 'paste')
  }

  const drop = (event: DragEvent<HTMLElement>): void => {
    event.preventDefault()
    if (busy) return
    const file = selectAcceptedImage(event.dataTransfer.files)
    if (file === undefined) {
      setError('Drop a PNG, JPEG, or WebP image')
      return
    }
    void ingest(file, 'drop')
  }

  return (
    <section className="luban-image" aria-label="Luban image paste">
      <style>{STYLE}</style>
      <p>选择、粘贴或拖入 PNG、JPEG、WebP 图片，最大 10 MB。对话 ID 留空时仅保存，不发送到对话。</p>
      <label>
        选择图片
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp"
          disabled={busy}
          onChange={(event): void => {
            const file = event.currentTarget.files?.[0]
            event.currentTarget.value = ''
            if (file !== undefined) void ingest(file, 'drop')
          }}
        />
      </label>
      <div className="luban-image__controls">
        <button
          type="button"
          disabled={busy}
          onClick={(): void => {
            setError('')
            void refresh().catch((reason: unknown): void =>
              setError(reason instanceof Error ? reason.message : '无法加载图片，请重试'),
            )
          }}
        >
          刷新图片
        </button>
        <input
          aria-label="对话 ID"
          placeholder="对话 ID（留空仅保存）"
          value={sessionId}
          onChange={(event): void => setSessionId(event.currentTarget.value)}
        />
        <select
          aria-label="发送格式"
          value={style}
          onChange={(event): void => setStyle(event.currentTarget.value as InjectStyle)}
        >
          <option value="markdown">Markdown 引用</option>
          <option value="path">绝对路径</option>
        </select>
        <button
          type="button"
          disabled={busy}
          onClick={(): void => {
            void cleanExpired()
              .then(refresh)
              .catch((reason: unknown): void =>
                setError(reason instanceof Error ? reason.message : 'Unable to clean images'),
              )
          }}
        >
          清理过期图片
        </button>
      </div>
      <div
        className="luban-image__drop"
        tabIndex={0}
        role="group"
        aria-label="Paste or drop an image"
        onPaste={paste}
        onDragOver={(event): void => event.preventDefault()}
        onDrop={drop}
      >
        {busy ? '上传中…' : '点击此处后按 Ctrl+V 粘贴，或将图片拖到这里'}
      </div>
      {error === '' ? null : (
        <div className="luban-image__error" role="alert">
          {error}
        </div>
      )}
      {notice === '' ? null : (
        <div className="luban-image__ok" role="status">
          {notice}
        </div>
      )}
      {images.length === 0 ? <p>暂无图片。上传后可在此预览和管理。</p> : null}
      <div className="luban-image__list" aria-label="Recent images">
        {images.map((image) => (
          <article className="luban-image__card" key={image.id}>
            <img src={image.previewUrl} alt={image.originalName} />
            <div className="luban-image__meta">{image.relPath}</div>
            <div className="luban-image__meta">
              {Math.ceil(image.bytes / 1024)} KiB · {image.compression.status} ·{' '}
              {image.referencedBy.length} session(s)
            </div>
            <button
              type="button"
              disabled={busy || image.referencedBy.length > 0}
              title={image.referencedBy.length > 0 ? '已被对话引用的附件会保留' : '删除附件'}
              onClick={(): void => {
                setBusy(true)
                void deleteImage(image.id)
                  .then(refresh)
                  .catch((reason: unknown): void =>
                    setError(reason instanceof Error ? reason.message : 'Unable to delete image'),
                  )
                  .finally((): void => setBusy(false))
              }}
            >
              删除
            </button>
          </article>
        ))}
      </div>
    </section>
  )
}

export const inject = ['slots']

/** Contribute authenticated paste/drop and recent-preview controls to the Luban workbench. */
export function apply(ctx: ClientContext): void {
  registerWorkbenchPage(ctx, {
    id: 'luban-image-paste',
    title: '图片与附件',
    group: '工具',
    order: 50,
    description: '上传、粘贴图片，并将附件加入当前对话。',
    component: ImagePasteSection,
  })
}
