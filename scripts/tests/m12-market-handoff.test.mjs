import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MARKET_TOPICS,
  MARKET_UPSTREAM,
  prepareMarketHandoff,
} from '../release/prepare-market-handoff.mjs'

const HEAD_SHA = '1234567890abcdef1234567890abcdef12345678'
const temporaryRoots = []

function sha256(content) {
  return createHash('sha256').update(content).digest('hex')
}

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-luban-market-handoff-'))
  temporaryRoots.push(root)
  return root
}

async function marketFixture(overrides = {}) {
  const root = await temporaryRoot()
  const packageRoot = join(root, 'packages', 'dsh-luban-sample')
  await mkdir(packageRoot, { recursive: true })
  await writeFile(
    join(packageRoot, 'package.json'),
    `${JSON.stringify(
      {
        name: 'dsh-luban-sample',
        version: '1.2.3',
        description: 'A deterministic sample plugin',
        repository: {
          type: 'git',
          url: 'git+https://github.com/yin52133/dsh-luban.git',
          directory: 'packages/dsh-luban-sample',
        },
        dsh: { bundle: { patch: './cordis.patch.yml' } },
        ...overrides,
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  return root
}

function localGitRunner(root, options = {}) {
  const calls = []
  const head = options.head ?? HEAD_SHA
  const mainline = options.mainline ?? head
  const outputs = new Map([
    ['rev-parse\0--show-toplevel', root],
    ['remote\0get-url\0origin', options.origin ?? 'https://github.com/yin52133/dsh-luban'],
    ['status\0--porcelain=v1\0--untracked-files=all', options.status ?? ''],
    ['rev-parse\0--verify\0HEAD^{commit}', head],
    ['rev-parse\0--verify\0refs/heads/mainline^{commit}', mainline],
  ])
  return {
    calls,
    runner: (args, cwd) => {
      calls.push({ args, cwd })
      const stdout = outputs.get(args.join('\0'))
      if (stdout === undefined) throw new Error(`Unexpected command: git ${args.join(' ')}`)
      return { status: 0, stdout: `${stdout}\n`, stderr: '' }
    },
  }
}

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  }
  return result.stdout.trim()
}

async function initializedMarketRepository() {
  const root = await marketFixture()
  await writeFile(join(root, '.gitignore'), '.luban/\n', 'utf8')
  git(root, ['init', '--initial-branch=mainline'])
  git(root, ['remote', 'add', 'origin', 'https://github.com/yin52133/dsh-luban'])
  git(root, ['add', '.'])
  git(root, [
    '-c',
    'user.name=Market Handoff Test',
    '-c',
    'user.email=market-handoff@example.invalid',
    'commit',
    '-m',
    'market fixture',
  ])
  return root
}

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe('M12 deterministic market handoff', () => {
  it('rejects conflicting CLI modes before inspecting a repository', () => {
    const result = spawnSync(
      process.execPath,
      [
        join(import.meta.dirname, '..', 'release', 'prepare-market-handoff.mjs'),
        '--package',
        'dsh-luban-sample',
        '--category',
        'dev',
        '--write',
        '--dry-run',
      ],
      { encoding: 'utf8', windowsHide: true },
    )
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('mutually exclusive')
  })

  it('binds the entry, clean mainline SHA, version, upstream schema, PR, and topic plan', async () => {
    const root = await marketFixture()
    const localGit = localGitRunner(root)
    const fetchSpy = vi.fn(() => {
      throw new Error('Network access is forbidden')
    })
    vi.stubGlobal('fetch', fetchSpy)

    const first = await prepareMarketHandoff({
      root,
      package: 'dsh-luban-sample',
      category: 'dev',
      gitRunner: localGit.runner,
    })
    const second = await prepareMarketHandoff({
      root,
      package: 'dsh-luban-sample',
      category: 'dev',
      gitRunner: localGit.runner,
    })

    expect(first.dryRun).toBe(true)
    expect(first.content).toBe(second.content)
    expect(first.contentSha256).toBe(sha256(first.content))
    expect(first.handoff.generation).toEqual({
      provenance: 'test-only',
      deterministic: true,
      createOnce: true,
      networkAccessPerformed: false,
      externalWritesPerformed: false,
    })
    expect(first.handoff.source).toMatchObject({
      repository: 'https://github.com/yin52133/dsh-luban',
      branch: 'mainline',
      gitSha: HEAD_SHA,
      clean: true,
      verifiedBranchRef: 'refs/heads/mainline',
      verifiedRemote: 'origin',
      package: {
        name: 'dsh-luban-sample',
        version: '1.2.3',
        subdirectory: 'packages/dsh-luban-sample',
      },
    })
    expect(first.handoff.upstream).toEqual({
      repository: MARKET_UPSTREAM.repository,
      ownerRepository: MARKET_UPSTREAM.ownerRepository,
      branch: MARKET_UPSTREAM.branch,
      ref: MARKET_UPSTREAM.ref,
      contributionGuide: MARKET_UPSTREAM.contributionGuide,
      schema: MARKET_UPSTREAM.schema,
      validation: {
        cwd: 'awesome-dsh-plugin',
        generatedFiles: ['README.md', 'README.zh-CN.md'],
        reviewedFiles: ['data/curated.yml', 'README.md', 'README.zh-CN.md'],
      },
    })
    expect(first.handoff.entry).toMatchObject({
      category: { slug: 'dev', name: 'Development' },
      record: {
        repo: 'yin52133/dsh-luban',
        subpath: 'packages/dsh-luban-sample',
      },
    })
    expect(first.handoff.entry.sha256).toBe(sha256(first.handoff.entry.yaml))
    expect(first.handoff.entry.derivedFrom.generator).toBe(
      'scripts/release/prepare-market-entry.mjs',
    )
    expect(first.handoff.pullRequest).toMatchObject({
      base: 'main',
      branch: 'market/add-dsh-luban-sample-1.2.3',
      title: 'Add dsh-luban-sample',
      dryRun: true,
      executed: false,
    })
    expect(first.handoff.pullRequest.body).toContain(`\`${HEAD_SHA}\``)
    expect(first.handoff.pullRequest.body).toContain(first.handoff.entry.sha256)
    expect(first.handoff.topics).toMatchObject({
      repository: 'yin52133/dsh-luban',
      desired: MARKET_TOPICS,
      mode: 'add-only',
      dryRun: true,
      executed: false,
    })
    expect(
      first.handoff.commands.map(
        ({ id, cwd, program, args, mutatesExternalState, requiresHumanApproval, executed }) => ({
          id,
          cwd,
          program,
          args,
          mutatesExternalState,
          requiresHumanApproval,
          executed,
        }),
      ),
    ).toEqual([
      {
        id: 'fork-upstream',
        cwd: '.',
        program: 'gh',
        args: ['repo', 'fork', 'DshMarketPlace/awesome-dsh-plugin', '--clone', '--remote'],
        mutatesExternalState: true,
        requiresHumanApproval: true,
        executed: false,
      },
      {
        id: 'create-market-branch',
        cwd: 'awesome-dsh-plugin',
        program: 'git',
        args: ['switch', '--create', 'market/add-dsh-luban-sample-1.2.3', MARKET_UPSTREAM.ref],
        mutatesExternalState: false,
        requiresHumanApproval: true,
        executed: false,
      },
      {
        id: 'install-upstream-dependencies',
        cwd: 'awesome-dsh-plugin',
        program: 'npm',
        args: ['ci'],
        mutatesExternalState: false,
        requiresHumanApproval: true,
        executed: false,
      },
      {
        id: 'validate-upstream-entry',
        cwd: 'awesome-dsh-plugin',
        program: 'npm',
        args: ['test'],
        mutatesExternalState: false,
        requiresHumanApproval: true,
        executed: false,
      },
      {
        id: 'review-upstream-diff',
        cwd: 'awesome-dsh-plugin',
        program: 'git',
        args: ['diff', '--', 'data/curated.yml', 'README.md', 'README.zh-CN.md'],
        mutatesExternalState: false,
        requiresHumanApproval: true,
        executed: false,
      },
      {
        id: 'stage-market-entry',
        cwd: 'awesome-dsh-plugin',
        program: 'git',
        args: ['add', '--', 'data/curated.yml', 'README.md', 'README.zh-CN.md'],
        mutatesExternalState: false,
        requiresHumanApproval: true,
        executed: false,
      },
      {
        id: 'commit-market-entry',
        cwd: 'awesome-dsh-plugin',
        program: 'git',
        args: ['commit', '-m', 'Add dsh-luban-sample'],
        mutatesExternalState: false,
        requiresHumanApproval: true,
        executed: false,
      },
      {
        id: 'push-market-branch',
        cwd: 'awesome-dsh-plugin',
        program: 'git',
        args: ['push', '--set-upstream', 'origin', 'market/add-dsh-luban-sample-1.2.3'],
        mutatesExternalState: true,
        requiresHumanApproval: true,
        executed: false,
      },
      {
        id: 'open-market-pr',
        cwd: 'awesome-dsh-plugin',
        program: 'gh',
        args: [
          'pr',
          'create',
          '--repo',
          'DshMarketPlace/awesome-dsh-plugin',
          '--base',
          'main',
          '--title',
          first.handoff.pullRequest.title,
          '--body',
          first.handoff.pullRequest.body,
        ],
        mutatesExternalState: true,
        requiresHumanApproval: true,
        executed: false,
      },
      {
        id: 'add-repository-topics',
        cwd: '.',
        program: 'gh',
        args: [
          'repo',
          'edit',
          'yin52133/dsh-luban',
          ...MARKET_TOPICS.flatMap((topic) => ['--add-topic', topic]),
        ],
        mutatesExternalState: true,
        requiresHumanApproval: true,
        executed: false,
      },
    ])
    expect(first.handoff.approvalBoundary).toMatchObject({
      required: true,
      grantedByArtifact: false,
      allCommandsRequireHumanApproval: true,
    })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(localGit.calls).toHaveLength(10)
    await expect(access(join(root, '.luban'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('writes one ignored, production-provenance artifact and refuses to overwrite it', async () => {
    const root = await initializedMarketRepository()
    const head = git(root, ['rev-parse', 'HEAD'])
    const first = await prepareMarketHandoff({
      root,
      package: 'dsh-luban-sample',
      category: 'dev',
      write: true,
    })

    expect(first.dryRun).toBe(false)
    expect(first.filename).toBe(`dsh-luban-sample-1.2.3-${head.slice(0, 12)}-market-handoff.json`)
    expect(await readFile(first.output, 'utf8')).toBe(first.content)
    expect(first.handoff.generation.provenance).toBe('local-clean-git')
    expect(git(root, ['status', '--porcelain=v1', '--untracked-files=all'])).toBe('')

    await expect(
      prepareMarketHandoff({
        root,
        package: 'dsh-luban-sample',
        category: 'dev',
        write: true,
      }),
    ).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await readFile(first.output, 'utf8')).toBe(first.content)
  })

  it('fails closed for dirty or non-mainline Git identities and injected writes', async () => {
    const root = await marketFixture()
    const wrongOrigin = localGitRunner(root, {
      origin: 'https://github.com/example/another-repository',
    })
    await expect(
      prepareMarketHandoff({
        root,
        package: 'dsh-luban-sample',
        category: 'dev',
        gitRunner: wrongOrigin.runner,
      }),
    ).rejects.toThrow(/origin must match/)

    const nonDefaultPort = localGitRunner(root, {
      origin: 'https://github.com:8443/yin52133/dsh-luban',
    })
    await expect(
      prepareMarketHandoff({
        root,
        package: 'dsh-luban-sample',
        category: 'dev',
        gitRunner: nonDefaultPort.runner,
      }),
    ).rejects.toThrow(/origin must match/)

    const dirty = localGitRunner(root, { status: ' M package.json' })
    await expect(
      prepareMarketHandoff({
        root,
        package: 'dsh-luban-sample',
        category: 'dev',
        gitRunner: dirty.runner,
      }),
    ).rejects.toThrow(/clean Git working tree/)

    const divergent = localGitRunner(root, { mainline: 'a'.repeat(40) })
    await expect(
      prepareMarketHandoff({
        root,
        package: 'dsh-luban-sample',
        category: 'dev',
        gitRunner: divergent.runner,
      }),
    ).rejects.toThrow(/HEAD must equal.*mainline/)

    const injected = localGitRunner(root)
    await expect(
      prepareMarketHandoff({
        root,
        package: 'dsh-luban-sample',
        category: 'dev',
        gitRunner: injected.runner,
        write: true,
      }),
    ).rejects.toThrow(/Injected Git runners cannot write/)
  })

  it('rejects stale upstream categories, invalid versions, and secret-like descriptions', async () => {
    const root = await marketFixture()
    const localGit = localGitRunner(root)
    await expect(
      prepareMarketHandoff({
        root,
        package: 'dsh-luban-sample',
        category: 'agi',
        gitRunner: localGit.runner,
      }),
    ).rejects.toThrow(/upstream category/)

    const invalidVersion = await marketFixture({ version: 'latest' })
    const invalidVersionGit = localGitRunner(invalidVersion)
    await expect(
      prepareMarketHandoff({
        root: invalidVersion,
        package: 'dsh-luban-sample',
        category: 'dev',
        gitRunner: invalidVersionGit.runner,
      }),
    ).rejects.toThrow(/valid SemVer/)

    const secret = await marketFixture({
      description: `Never include github_pat_${'a'.repeat(30)}`,
    })
    const secretGit = localGitRunner(secret)
    await expect(
      prepareMarketHandoff({
        root: secret,
        package: 'dsh-luban-sample',
        category: 'dev',
        gitRunner: secretGit.runner,
      }),
    ).rejects.toThrow(/secret-like/)

    const npmSecret = await marketFixture({
      description: `Never include npm_${'a'.repeat(36)}`,
    })
    const npmSecretGit = localGitRunner(npmSecret)
    await expect(
      prepareMarketHandoff({
        root: npmSecret,
        package: 'dsh-luban-sample',
        category: 'dev',
        gitRunner: npmSecretGit.runner,
      }),
    ).rejects.toThrow(/secret-like/)
  })
})
