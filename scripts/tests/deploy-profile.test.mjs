import { spawnSync } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, parse, resolve } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { profileSetupPlan, setupProfile } from '../deploy/setup-profile.mjs'

const TEST_DIR = fileURLToPath(new URL('.', import.meta.url))
const REPOSITORY_ROOT = resolve(TEST_DIR, '..', '..')
const temporaryRoots = []

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), 'luban-profile-setup-'))
  temporaryRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe('profile deployment setup', () => {
  it('previews the exact allowlisted template without writing by default', async () => {
    const dshHome = await temporaryRoot()
    const result = await setupProfile({ profile: 'win-debug', dshHome })

    expect(result).toMatchObject({ profile: 'win-debug', dshHome, dryRun: true })
    expect(result.files).toEqual([
      'package.json',
      'pnpm-workspace.yaml',
      'cordis.patch.yml',
      'README.md',
    ])
    await expect(readFile(join(result.target, 'package.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('creates one complete profile and refuses to overwrite user changes', async () => {
    const dshHome = await temporaryRoot()
    const result = await setupProfile({ profile: 'ubuntu-server', dshHome, apply: true })
    const manifest = JSON.parse(await readFile(join(result.target, 'package.json'), 'utf8'))
    expect(manifest.dsh.profile.bundles).toEqual([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
    ])

    const patch = join(result.target, 'cordis.patch.yml')
    await writeFile(patch, '# user-owned\n[]\n', 'utf8')
    await expect(setupProfile({ profile: 'ubuntu-server', dshHome, apply: true })).rejects.toThrow(
      /Refusing to overwrite/u,
    )
    expect(await readFile(patch, 'utf8')).toBe('# user-owned\n[]\n')
  })

  it('rejects unknown profiles, filesystem roots, and conflicting CLI modes', async () => {
    const dshHome = await temporaryRoot()
    expect(() => profileSetupPlan({ profile: '../escape', dshHome })).toThrow(
      /Unsupported profile/u,
    )
    expect(() => profileSetupPlan({ profile: 'win-debug', dshHome: parse(dshHome).root })).toThrow(
      /filesystem root/u,
    )

    const result = spawnSync(
      process.execPath,
      [
        join(REPOSITORY_ROOT, 'scripts/deploy/setup-profile.mjs'),
        '--profile',
        'win-debug',
        '--apply',
        '--dry-run',
      ],
      { encoding: 'utf8', windowsHide: true },
    )
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('mutually exclusive')
  })

  it('keeps the platform wrapper in preview mode unless apply is explicit', async () => {
    const dshHome = await temporaryRoot()
    const result =
      process.platform === 'win32'
        ? spawnSync(
            'pwsh.exe',
            [
              '-NoProfile',
              '-File',
              join(REPOSITORY_ROOT, 'scripts/deploy/setup-windows.ps1'),
              '-DshHome',
              dshHome,
              '-DryRun',
            ],
            { encoding: 'utf8', windowsHide: true },
          )
        : spawnSync(
            'sh',
            [
              join(REPOSITORY_ROOT, 'scripts/deploy/setup-ubuntu.sh'),
              '--dsh-home',
              dshHome,
              '--dry-run',
            ],
            { encoding: 'utf8' },
          )
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('"dryRun": true')
  }, 15_000)

  it('rejects a profiles junction that would write outside DSH_HOME', async () => {
    const dshHome = await temporaryRoot()
    const outside = await temporaryRoot()
    await mkdir(outside, { recursive: true })
    await symlink(
      outside,
      join(dshHome, 'profiles'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )

    await expect(setupProfile({ profile: 'win-debug', dshHome })).rejects.toThrow(
      /junction|outside its configured root/u,
    )
    await expect(setupProfile({ profile: 'win-debug', dshHome, apply: true })).rejects.toThrow(
      /junction|outside its configured root/u,
    )
    await expect(access(join(outside, 'win-debug', 'package.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})
