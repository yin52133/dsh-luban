import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createProfileSmokePlan,
  evaluateLazyClient,
  isOwnedTemporaryRoot,
  m12PluginInstallArgs,
  m12TsdownArgs,
  removeOwnedTemporaryRoot,
  runM12ProfileSmoke,
} from '../acceptance/m12-profile-smoke.mjs'

const directories = new Set()

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), 'luban-m12-profile-smoke-test-'))
  directories.add(root)
  return root
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(
    [...directories].map(async (directory) => {
      await rm(directory, { recursive: true, force: true })
      directories.delete(directory)
    }),
  )
})

describe('M12 real profile smoke runner', () => {
  it('defaults to a non-writing plan and selects the platform profile', async () => {
    const root = await temporaryRoot()
    const result = await runM12ProfileSmoke({ root, platform: 'linux', runId: 'plan-run' })

    expect(result).toMatchObject({
      featureId: 'M12-F001',
      runId: 'plan-run',
      profile: 'ubuntu-server',
      evidenceKind: 'none',
      status: 'planned',
      acceptancePassed: false,
    })
    await expect(
      readFile(join(root, 'node_modules', '.cache', 'dsh-luban-acceptance', 'anything')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    expect(createProfileSmokePlan({ root, platform: 'win32' }).profile).toBe('win-debug')
    expect(() => createProfileSmokePlan({ root, platform: 'darwin' })).toThrow(/unsupported/u)
  })

  it('never promotes injected fake execution to live acceptance evidence', async () => {
    const executeLive = vi.fn(async () => ({
      status: 'pass',
      checks: [{ id: 'fake', status: 'pass', actual: 'simulated only' }],
      cleanup: 'pass',
    }))
    const result = await runM12ProfileSmoke(
      { live: true, platform: 'linux', runId: 'fake-run' },
      { executeLive },
    )

    expect(executeLive).toHaveBeenCalledOnce()
    expect(result).toMatchObject({
      evidenceKind: 'simulated',
      status: 'simulated',
      acceptancePassed: false,
    })
  })

  it('fails closed before side effects when project-local dsh is absent', async () => {
    const root = await temporaryRoot()
    const result = await runM12ProfileSmoke({
      root,
      live: true,
      platform: process.platform,
      runId: 'blocked-run',
    })

    expect(result).toMatchObject({
      evidenceKind: 'live',
      status: 'blocked',
      acceptancePassed: false,
      cleanup: 'not-needed',
    })
    expect(result.checks).toContainEqual(
      expect.objectContaining({ id: 'live-preflight', status: 'blocked' }),
    )
    await expect(
      readFile(join(root, 'node_modules', '.cache', 'dsh-luban-acceptance', 'anything')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('only removes absolute, directly owned smoke roots from the ignored cache', async () => {
    const root = await temporaryRoot()
    const owner = join(root, 'node_modules', '.cache', 'dsh-luban-acceptance')
    const owned = join(owner, 'm12-profile-delete-me')
    const outside = join(root, 'node_modules', '.cache', 'dsh-luban-acceptance-other')
    const prefixTrick = join(outside, 'm12-profile-keep-me')
    await mkdir(owned, { recursive: true })
    await mkdir(prefixTrick, { recursive: true })

    expect(isOwnedTemporaryRoot(root, owned)).toBe(true)
    expect(isOwnedTemporaryRoot(root, 'm12-profile-relative')).toBe(false)
    expect(isOwnedTemporaryRoot(root, owner)).toBe(false)
    expect(isOwnedTemporaryRoot(root, join(owned, 'nested'))).toBe(false)
    expect(isOwnedTemporaryRoot(root, prefixTrick)).toBe(false)

    await expect(removeOwnedTemporaryRoot(root, prefixTrick)).rejects.toThrow(
      /Refusing to clean an unowned temporary path/u,
    )
    await expect(stat(prefixTrick)).resolves.toMatchObject({})
    await removeOwnedTemporaryRoot(root, owned)
    await expect(stat(owned)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('uses offline profile installation and evaluates a lazy-CJS lifecycle', () => {
    expect(m12TsdownArgs('D:\\repo\\node_modules\\tsdown\\dist\\run.mjs')).toEqual([
      'D:\\repo\\node_modules\\tsdown\\dist\\run.mjs',
      '--config-loader',
      'tsx',
    ])
    expect(
      m12PluginInstallArgs('ubuntu-server', 'C:\\fixture\\plugin', 'C:\\fixture\\pnpm-store'),
    ).toEqual([
      'plugin',
      '--profile',
      'ubuntu-server',
      '--ignore-workspace',
      'add',
      '--offline',
      '--config.auto-install-peers=false',
      '--store-dir',
      'C:/fixture/pnpm-store',
      'file:C:/fixture/plugin',
    ])

    const source = `window.__ModuleLoader__.load({
      id: 'dsh-luban-acceptance',
      factory: function () {
        return {
          apply: function (ctx) {
            Reflect.set(globalThis, '__LUBAN_M12_CLIENT_LIFECYCLE__', { runId: 'client-run', event: 'mounted' })
            ctx.effect(function () {
              return function () {
                Reflect.set(globalThis, '__LUBAN_M12_CLIENT_LIFECYCLE__', { runId: 'client-run', event: 'disposed' })
              }
            })
          }
        }
      }
    })`
    expect(evaluateLazyClient(source, 'client-run')).toEqual({
      moduleId: 'dsh-luban-acceptance',
      lifecycle: ['mounted', 'disposed'],
    })
    expect(() => evaluateLazyClient('window.__ModuleLoader__.load({ id: "wrong" })', 'x')).toThrow(
      /expected lazy-CJS/u,
    )
  })
})
