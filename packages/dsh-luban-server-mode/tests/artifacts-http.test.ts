import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { access, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AuthService } from '@yin52133/dsh-luban-core'
import { asAccountId } from '@yin52133/dsh-luban-core'
import { afterEach, describe, expect, it } from 'vitest'
import { ArtifactLinkSigner, ArtifactManager, attachmentName } from '../src/artifacts.js'
import type { BuildTemplateConfig } from '../src/config.js'
import type { BuildExecutionRequest, BuildExecutor } from '../src/executor.js'
import { ServerModeHttpApi } from '../src/http-api.js'
import { BuildLedgerStore } from '../src/ledger.js'
import type { ProcessOptions, ProcessResult, ProcessRunner } from '../src/process-runner.js'
import { BuildQueue } from '../src/queue.js'
import type { ResourceProbe, ResourceSample } from '../src/resources.js'
import { DefaultServerModeService } from '../src/service.js'
import { UserSystemdInstaller } from '../src/systemd.js'
import type { WorkerResult } from '../src/worker-protocol.js'

const directories = new Set<string>()

class UnusedExecutor implements BuildExecutor {
  public execute(_request: BuildExecutionRequest, _signal: AbortSignal): Promise<WorkerResult> {
    throw new Error('test queue must not execute')
  }
}

class StaticProbe implements ResourceProbe {
  public sample(): Promise<ResourceSample> {
    return Promise.resolve({ diskFreeGb: 100, load1: 1 })
  }
}

class NoopRunner implements ProcessRunner {
  public run(
    _command: string,
    _args: readonly string[],
    _options: ProcessOptions,
  ): Promise<ProcessResult> {
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', durationMs: 0 })
  }
}

const TEMPLATE: BuildTemplateConfig = {
  id: 'fake',
  title: 'Fake',
  command: 'fake',
  args: ['${workspace}'],
  cwd: '${workspace}',
  collect: [],
}

function auth(): Pick<AuthService, 'middleware'> {
  return {
    middleware(): ReturnType<AuthService['middleware']> {
      return (request) =>
        Promise.resolve(
          request.cookie === 'session=ok'
            ? { allowed: true, status: 200, user: 'alice' }
            : request.cookie === 'session=bob'
              ? { allowed: true, status: 200, user: 'bob' }
              : { allowed: false, status: 401 },
        )
    },
  }
}

afterEach(async (): Promise<void> => {
  await Promise.all(
    [...directories].map(async (directory): Promise<void> => {
      await rm(directory, { recursive: true, force: true })
      directories.delete(directory)
    }),
  )
})

describe('ArtifactManager and ArtifactLinkSigner', (): void => {
  it('discovers regular files, confines paths, prunes exact runs, and expires signatures', async (): Promise<void> => {
    const directory = join(tmpdir(), `luban-artifacts-${randomUUID()}`)
    directories.add(directory)
    const manager = new ArtifactManager(directory)
    const jobId = randomUUID()
    const run = manager.jobDirectory(jobId)
    await mkdir(join(run, 'nested'), { recursive: true })
    await writeFile(join(run, 'nested', 'firmware.bin'), 'firmware', 'utf8')
    const [artifact] = await manager.discover(jobId)
    expect(artifact).toMatchObject({ name: 'nested/firmware.bin', sizeBytes: 8 })
    if (artifact === undefined) throw new Error('artifact fixture is missing')
    await expect(manager.secureFile(jobId, artifact)).resolves.toMatchObject({ sizeBytes: 8 })
    expect(() =>
      manager.resolveArtifact(jobId, {
        name: 'escape',
        path: join(directory, '..', 'secret'),
        sizeBytes: 1,
      }),
    ).toThrow(/escapes/u)

    let now = 1_000_000
    const signer = new ArtifactLinkSigner({
      key: Buffer.alloc(32, 7),
      ttlSec: 60,
      now: (): number => now,
    })
    const link = signer.sign(jobId, artifact.name)
    expect(signer.verify(jobId, artifact.name, link.expires, link.signature)).toBe(true)
    expect(signer.verify(jobId, 'other', link.expires, link.signature)).toBe(false)
    now += 61_000
    expect(signer.verify(jobId, artifact.name, link.expires, link.signature)).toBe(false)
    expect(attachmentName('固件".bin')).toMatch(/^[\x20-\x7E]+$/u)

    await manager.prune([jobId])
    await expect(manager.discover(jobId)).resolves.toEqual([])
  })

  it('rejects a job-directory junction without reading or pruning its target', async (): Promise<void> => {
    const directory = join(tmpdir(), `luban-artifact-junction-${randomUUID()}`)
    const root = join(directory, 'artifacts')
    const outside = join(directory, 'outside')
    directories.add(directory)
    await mkdir(root, { recursive: true })
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'private.txt'), 'outside', 'utf8')
    const jobId = randomUUID()
    await symlink(outside, join(root, jobId), process.platform === 'win32' ? 'junction' : 'dir')
    const manager = new ArtifactManager(root)

    await expect(manager.discover(jobId)).rejects.toThrow(/symbolic link|junction/u)
    await expect(
      manager.secureFile(jobId, {
        name: 'private.txt',
        path: join(root, jobId, 'private.txt'),
        sizeBytes: 7,
      }),
    ).rejects.toThrow(/symbolic link|junction/u)
    await expect(manager.prune([jobId])).rejects.toThrow(/symbolic link|junction/u)
    await expect(access(join(outside, 'private.txt'))).resolves.toBeUndefined()
  })
})

describe('ServerModeHttpApi', (): void => {
  it('authenticates REST/SSE and serves only signed job-owned artifacts', async (): Promise<void> => {
    const directory = join(tmpdir(), `luban-server-http-${randomUUID()}`)
    const workspace = join(directory, 'workspace')
    await mkdir(workspace, { recursive: true })
    directories.add(directory)
    const artifacts = new ArtifactManager(join(directory, 'artifacts'))
    const store = new BuildLedgerStore(join(directory, 'ledger.json'))
    const queue = new BuildQueue({
      store,
      executor: new UnusedExecutor(),
      artifacts,
      probe: new StaticProbe(),
      templates: [TEMPLATE],
      workspaceRoots: [directory],
      maxConcurrent: 1,
      defaultTimeoutMs: 1_000,
      diskMinGb: 10,
      loadMax: 8,
      checkIntervalMs: 60_000,
      retainRuns: 10,
    })
    const done = await queue.enqueue({
      accountId: asAccountId('alice'),
      templateId: TEMPLATE.id,
      params: { workspace },
    })
    const run = artifacts.jobDirectory(done.id)
    await mkdir(join(run, 'nested'), { recursive: true })
    await writeFile(join(run, 'nested', 'firmware.bin'), 'signed artifact', 'utf8')
    const refs = await artifacts.discover(done.id)
    await store.update((ledger) => {
      const record = ledger.records[done.id]
      if (record === undefined) throw new Error('job fixture is missing')
      return {
        ...ledger,
        records: {
          ...ledger.records,
          [done.id]: {
            ...record,
            job: {
              ...record.job,
              status: 'done',
              artifacts: refs,
              errorLogExcerpt: 'diagnostic excerpt',
              version: record.job.version + 1,
            },
            finishedAt: Date.now(),
          },
        },
      }
    })
    const service = new DefaultServerModeService(
      new UserSystemdInstaller({
        runner: new NoopRunner(),
        serviceName: 'dsh-luban',
        dshExecutable: process.execPath,
        timeoutMs: 1_000,
        platform: 'linux',
        unitDirectory: join(directory, 'units'),
      }),
      queue,
    )
    const signer = new ArtifactLinkSigner({
      key: Buffer.alloc(32, 9),
      ttlSec: 300,
    })
    const api = new ServerModeHttpApi({ service, auth: auth(), artifacts, signer })
    const server = createServer((request, response): void => {
      void api.handler(request, response)
    })
    await new Promise<void>((resolve, reject): void => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address() as AddressInfo
    const origin = `http://127.0.0.1:${String(address.port)}`
    const base = `${origin}/luban-server-mode`
    const cookie = { cookie: 'session=ok' }
    const bobCookie = { cookie: 'session=bob' }

    expect((await fetch(`${base}/jobs`)).status).toBe(401)
    const jobs = await fetch(`${base}/jobs`, { headers: cookie })
    expect(jobs.status).toBe(200)
    expect(await jobs.json()).toMatchObject({ jobs: [{ id: done.id, status: 'done' }] })
    expect(await (await fetch(`${base}/jobs`, { headers: bobCookie })).json()).toEqual({ jobs: [] })
    expect((await fetch(`${base}/jobs/${done.id}`, { headers: bobCookie })).status).toBe(404)

    const artifactList = await fetch(`${base}/jobs/${done.id}/artifacts`, { headers: cookie })
    const artifactBody = (await artifactList.json()) as {
      readonly artifacts: readonly { readonly downloadUrl: string; readonly name: string }[]
    }
    const link = artifactBody.artifacts[0]?.downloadUrl
    expect(artifactBody.artifacts[0]?.name).toBe('nested/firmware.bin')
    if (link === undefined) throw new Error('signed link is missing')
    expect((await fetch(`${origin}${link}`)).status).toBe(401)
    const downloaded = await fetch(`${origin}${link}`, { headers: cookie })
    expect(downloaded.status).toBe(200)
    expect(await downloaded.text()).toBe('signed artifact')
    expect((await fetch(`${origin}${link}`, { headers: bobCookie })).status).toBe(404)
    const tampered = new URL(`${origin}${link}`)
    tampered.searchParams.set('signature', 'bad')
    expect((await fetch(tampered, { headers: cookie })).status).toBe(403)

    const log = await fetch(`${base}/jobs/${done.id}/error-log`, { headers: cookie })
    expect(await log.json()).toEqual({ excerpt: 'diagnostic excerpt' })
    expect((await fetch(`${base}/jobs/${done.id}/error-log`, { headers: bobCookie })).status).toBe(
      404,
    )

    const bobCreated = await fetch(`${base}/jobs`, {
      method: 'POST',
      headers: { ...bobCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        accountId: 'alice',
        templateId: TEMPLATE.id,
        params: { workspace },
      }),
    })
    expect(bobCreated.status).toBe(202)
    expect(await bobCreated.json()).toMatchObject({ job: { accountId: 'bob' } })
    expect(await (await fetch(`${base}/jobs`, { headers: cookie })).json()).toMatchObject({
      jobs: [{ id: done.id, accountId: 'alice' }],
    })
    const bobStream = await fetch(`${base}/events`, { headers: bobCookie })
    if (bobStream.body === null) throw new Error('Bob SSE response has no body')
    const bobReader = bobStream.body.getReader()
    const bobChunk = new TextDecoder().decode((await bobReader.read()).value)
    expect(bobChunk).toContain('event: baseline')
    expect(bobChunk).toContain('"accountId":"bob"')
    expect(bobChunk).not.toContain(done.id)
    await bobReader.cancel()
    const stream = await fetch(`${base}/events`, { headers: cookie })
    expect(stream.headers.get('content-type')).toContain('text/event-stream')
    await stream.body?.cancel()

    const restartedStream = await fetch(`${base}/events`, {
      headers: { ...cookie, 'last-event-id': '999' },
    })
    if (restartedStream.body === null) throw new Error('Restarted SSE response has no body')
    const restartedReader = restartedStream.body.getReader()
    const restartedChunk = await restartedReader.read()
    expect(new TextDecoder().decode(restartedChunk.value)).toContain('event: baseline')
    await restartedReader.cancel()

    api.dispose()
    await service.dispose()
    await new Promise<void>((resolve, reject): void => {
      server.close((error): void => (error === undefined ? resolve() : reject(error)))
    })
  })
})
