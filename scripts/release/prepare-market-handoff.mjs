#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { pathToFileURL, URL } from 'node:url'
import { pathIsWithin, REPOSITORY_ROOT, sha256 } from './lib.mjs'
import { prepareMarketEntry } from './prepare-market-entry.mjs'

export const MARKET_HANDOFF_SCHEMA_VERSION = 1
export const MARKET_UPSTREAM = Object.freeze({
  repository: 'https://github.com/DshMarketPlace/awesome-dsh-plugin',
  ownerRepository: 'DshMarketPlace/awesome-dsh-plugin',
  branch: 'main',
  ref: '2dea4eaad3c01782b9f650ec30d562ae80ad8622',
  contributionGuide: 'CONTRIBUTING.md',
  schema: Object.freeze({
    id: 'awesome-dsh-plugin/curated-yaml-v1',
    path: 'data/curated.yml',
    categorySelector: 'categories[].slug',
    entrySelector: 'categories[].plugins[]',
    requiredFields: Object.freeze(['repo']),
    optionalFields: Object.freeze(['subpath']),
  }),
})

export const MARKET_TOPICS = Object.freeze([
  'dsh-plugin',
  'dsh',
  'deepseek-harness',
  'workbench',
  'embedded',
])

export const UPSTREAM_MARKET_CATEGORIES = Object.freeze({
  ui: 'UI & Experience',
  model: 'Models & Providers',
  memory: 'Memory',
  tools: 'Tools & Capabilities',
  vision: 'Vision & Multimodal',
  workflow: 'Workflow & Automation',
  skill: 'Skills',
  session: 'Sessions',
  theme: 'Theme & Appearance',
  market: 'Plugin Managers & Marketplaces',
  dev: 'Development',
  fun: 'Fun & Experimental',
})

const PACKAGE_NAME = /^dsh-luban-[a-z0-9]+(?:-[a-z0-9]+)*$/u
const UPSTREAM_WORKTREE = 'awesome-dsh-plugin'
const UPSTREAM_GENERATED_FILES = Object.freeze(['README.md', 'README.zh-CN.md'])
const SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u
const GIT_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u
const SECRET_PATTERNS = Object.freeze([
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/u,
  /\bnpm_[A-Za-z0-9]{20,}\b/u,
  /\bsk-[A-Za-z0-9]{20,}\b/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/u,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*\b/iu,
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/u,
])

function parseArgs(argv) {
  const options = { write: false }
  let requestedMode
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const value = () => {
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`${argument} requires a value`)
      }
      index += 1
      return next
    }
    if (argument === '--package') options.package = value()
    else if (argument === '--category') options.category = value()
    else if (argument === '--write' || argument === '--dry-run') {
      const mode = argument === '--write' ? 'write' : 'dry-run'
      if (requestedMode !== undefined && requestedMode !== mode) {
        throw new Error('--write and --dry-run are mutually exclusive')
      }
      requestedMode = mode
      options.write = mode === 'write'
    } else if (argument === '--help') options.help = true
    else throw new Error(`Unknown option: ${argument}`)
  }
  return options
}

function defaultGitRunner(args, cwd) {
  const env = { GIT_OPTIONAL_LOCKS: '0' }
  for (const name of [
    'PATH',
    'PATHEXT',
    'SystemRoot',
    'SYSTEMROOT',
    'WINDIR',
    'ComSpec',
    'COMSPEC',
    'TEMP',
    'TMP',
    'LANG',
    'LC_ALL',
  ]) {
    if (process.env[name] !== undefined) env[name] = process.env[name]
  }
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    env,
  })
}

function gitText(root, args, runner, label) {
  const result = runner(args, root)
  if (
    result === null ||
    typeof result !== 'object' ||
    result.status !== 0 ||
    typeof result.stdout !== 'string'
  ) {
    throw new Error(`Unable to verify ${label} from local Git`)
  }
  return result.stdout.trim()
}

function samePath(left, right) {
  const normalize = (value) => {
    const normalized = resolve(value).replaceAll(sep, '/')
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized
  }
  return normalize(left) === normalize(right)
}

function githubRepositoryIdentity(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname.toLowerCase() !== 'github.com' ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    return undefined
  }
  const pathname = url.pathname
    .replace(/^\//u, '')
    .replace(/(?:\.git)?\/$/u, '')
    .replace(/\.git$/u, '')
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(pathname) ? pathname.toLowerCase() : undefined
}

function localGitIdentity(root, runner, expectedRepository) {
  const topLevel = gitText(root, ['rev-parse', '--show-toplevel'], runner, 'repository root')
  if (!samePath(topLevel, root)) {
    throw new Error('Market handoff root must be the local Git repository root')
  }
  const origin = gitText(root, ['remote', 'get-url', 'origin'], runner, 'origin repository')
  if (
    githubRepositoryIdentity(origin) === undefined ||
    githubRepositoryIdentity(origin) !== githubRepositoryIdentity(expectedRepository)
  ) {
    throw new Error('Market handoff origin must match the credential-free package repository')
  }

  const status = gitText(
    root,
    ['status', '--porcelain=v1', '--untracked-files=all'],
    runner,
    'working tree state',
  )
  if (status !== '') throw new Error('Market handoff requires a clean Git working tree')

  const sha = gitText(root, ['rev-parse', '--verify', 'HEAD^{commit}'], runner, 'HEAD commit')
  const mainlineSha = gitText(
    root,
    ['rev-parse', '--verify', 'refs/heads/mainline^{commit}'],
    runner,
    'mainline commit',
  )
  if (!GIT_SHA.test(sha) || !GIT_SHA.test(mainlineSha)) {
    throw new Error('Local Git returned an invalid commit identity')
  }
  if (sha !== mainlineSha) {
    throw new Error('Market handoff HEAD must equal the local mainline commit')
  }
  return { sha, branchRef: 'refs/heads/mainline', remote: 'origin', clean: true }
}

function assertSecretFree(content) {
  if (SECRET_PATTERNS.some((pattern) => pattern.test(content))) {
    throw new Error('Market handoff contains secret-like material')
  }
}

function upstreamEntry(sourceIdentity) {
  const content = [
    `      - repo: ${sourceIdentity.owner}/${sourceIdentity.repository}`,
    `        subpath: ${sourceIdentity.subdirectory}`,
    '',
  ].join('\n')
  return {
    record: {
      repo: `${sourceIdentity.owner}/${sourceIdentity.repository}`,
      subpath: sourceIdentity.subdirectory,
    },
    yaml: content,
    sha256: sha256(content),
  }
}

function command(id, cwd, program, args, effect, mutatesExternalState = false) {
  return {
    id,
    cwd,
    program,
    args,
    effect,
    mutatesExternalState,
    requiresHumanApproval: true,
    executed: false,
  }
}

function pullRequestBody(input) {
  return [
    '## Plugin Information',
    '',
    `- **Repository**: ${input.repositoryUrl}`,
    `- **Monorepo subpath**: \`${input.subdirectory}\``,
    `- **Package/version**: \`${input.package}@${input.version}\``,
    `- **Category**: ${input.categoryName} (\`${input.category}\`)`,
    `- **Install Command**: \`dsh plugin --profile <profile> add ${input.package}@${input.version}\``,
    `- **Source commit**: \`${input.gitSha}\``,
    `- **Entry SHA-256**: \`${input.entryChecksum}\``,
    '',
    '## What does it do?',
    '',
    input.description,
    '',
    '## Why should it be included?',
    '',
    `${input.package} is an installable DeepSeek Harness plugin from the dsh-luban workbench suite.`,
    '',
    '## Checklist',
    '',
    '- [ ] Plugin is actively maintained',
    '- [ ] README has installation instructions',
    '- [ ] GitHub topics include `dsh-plugin` and `deepseek-harness`',
    '- [ ] Plugin has been tested and works',
    '- [ ] No duplicate functionality',
    '- [ ] Pinned upstream schema was rechecked and `npm test` passed',
    '',
  ].join('\n')
}

function buildHandoff(input) {
  const sourceRepository = `https://github.com/${input.sourceIdentity.owner}/${input.sourceIdentity.repository}`
  const entry = upstreamEntry(input.sourceIdentity)
  const categoryName = UPSTREAM_MARKET_CATEGORIES[input.category]
  const title = `Add ${input.package}`
  const branch = `market/add-${input.package}-${input.version}`
  const body = pullRequestBody({
    repositoryUrl: sourceRepository,
    subdirectory: input.sourceIdentity.subdirectory,
    package: input.package,
    version: input.version,
    category: input.category,
    categoryName,
    gitSha: input.git.sha,
    entryChecksum: entry.sha256,
    description: input.description,
  })
  const topicArgs = [
    'repo',
    'edit',
    `${input.sourceIdentity.owner}/${input.sourceIdentity.repository}`,
    ...MARKET_TOPICS.flatMap((topic) => ['--add-topic', topic]),
  ]

  return {
    schemaVersion: MARKET_HANDOFF_SCHEMA_VERSION,
    kind: 'dsh-luban-market-handoff',
    generation: {
      provenance: input.provenance,
      deterministic: true,
      createOnce: true,
      networkAccessPerformed: false,
      externalWritesPerformed: false,
    },
    source: {
      repository: sourceRepository,
      branch: input.sourceIdentity.branch,
      gitSha: input.git.sha,
      clean: input.git.clean,
      verifiedBranchRef: input.git.branchRef,
      verifiedRemote: input.git.remote,
      package: {
        name: input.package,
        version: input.version,
        subdirectory: input.sourceIdentity.subdirectory,
      },
    },
    upstream: {
      repository: MARKET_UPSTREAM.repository,
      ownerRepository: MARKET_UPSTREAM.ownerRepository,
      branch: MARKET_UPSTREAM.branch,
      ref: MARKET_UPSTREAM.ref,
      contributionGuide: MARKET_UPSTREAM.contributionGuide,
      schema: MARKET_UPSTREAM.schema,
      validation: {
        cwd: UPSTREAM_WORKTREE,
        generatedFiles: UPSTREAM_GENERATED_FILES,
        reviewedFiles: [MARKET_UPSTREAM.schema.path, ...UPSTREAM_GENERATED_FILES],
      },
    },
    entry: {
      category: { slug: input.category, name: categoryName },
      ...entry,
      derivedFrom: {
        generator: 'scripts/release/prepare-market-entry.mjs',
        candidateFilename: input.candidate.filename,
        candidateSha256: sha256(input.candidate.content),
      },
    },
    pullRequest: {
      base: MARKET_UPSTREAM.branch,
      branch,
      title,
      body,
      dryRun: true,
      executed: false,
    },
    topics: {
      repository: `${input.sourceIdentity.owner}/${input.sourceIdentity.repository}`,
      desired: MARKET_TOPICS,
      mode: 'add-only',
      dryRun: true,
      executed: false,
    },
    commands: [
      command(
        'fork-upstream',
        '.',
        'gh',
        ['repo', 'fork', MARKET_UPSTREAM.ownerRepository, '--clone', '--remote'],
        'Creates an authorized maintainer fork and local clone.',
        true,
      ),
      command(
        'create-market-branch',
        UPSTREAM_WORKTREE,
        'git',
        ['switch', '--create', branch, MARKET_UPSTREAM.ref],
        'Creates a local branch from the schema-locked upstream commit.',
      ),
      command(
        'install-upstream-dependencies',
        UPSTREAM_WORKTREE,
        'npm',
        ['ci'],
        'Installs the dependency lock used by the pinned upstream validator.',
      ),
      command(
        'validate-upstream-entry',
        UPSTREAM_WORKTREE,
        'npm',
        ['test'],
        'Validates the entry and regenerates the upstream English and Chinese README files.',
      ),
      command(
        'review-upstream-diff',
        UPSTREAM_WORKTREE,
        'git',
        ['diff', '--', MARKET_UPSTREAM.schema.path, ...UPSTREAM_GENERATED_FILES],
        'Displays the registry and generated README diff for mandatory human review.',
      ),
      command(
        'stage-market-entry',
        UPSTREAM_WORKTREE,
        'git',
        ['add', '--', MARKET_UPSTREAM.schema.path, ...UPSTREAM_GENERATED_FILES],
        'Stages only the reviewed registry and generated README files.',
      ),
      command(
        'commit-market-entry',
        UPSTREAM_WORKTREE,
        'git',
        ['commit', '-m', title],
        'Commits the reviewed and validated registry entry locally.',
      ),
      command(
        'push-market-branch',
        UPSTREAM_WORKTREE,
        'git',
        ['push', '--set-upstream', 'origin', branch],
        'Pushes the reviewed market branch to the authorized fork.',
        true,
      ),
      command(
        'open-market-pr',
        UPSTREAM_WORKTREE,
        'gh',
        [
          'pr',
          'create',
          '--repo',
          MARKET_UPSTREAM.ownerRepository,
          '--base',
          MARKET_UPSTREAM.branch,
          '--title',
          title,
          '--body',
          body,
        ],
        'Opens the reviewed pull request from the checked-out fork branch.',
        true,
      ),
      command(
        'add-repository-topics',
        '.',
        'gh',
        topicArgs,
        'Adds the approved discovery topics without removing existing topics.',
        true,
      ),
    ],
    manualSteps: [
      `Recheck ${MARKET_UPSTREAM.contributionGuide} and ${MARKET_UPSTREAM.schema.path} at the pinned ref against current upstream main.`,
      `After install-upstream-dependencies and before validate-upstream-entry, insert entry.yaml exactly once under categories[].plugins[] where slug is ${input.category}.`,
      `After npm test regenerates README.md and README.zh-CN.md, run review-upstream-diff and confirm all three reviewed files before staging.`,
      `Confirm the ${MARKET_UPSTREAM.schema.path} entry matches entry.sha256 before commit.`,
    ],
    approvalBoundary: {
      required: true,
      grantedByArtifact: false,
      allCommandsRequireHumanApproval: true,
      externalActionsBlockedUntilApproval: [
        'fork-upstream',
        'push-market-branch',
        'open-market-pr',
        'add-repository-topics',
      ],
      preconditions: [
        'An authorized maintainer rechecks the pinned contribution guide and curated schema.',
        'The exact entry YAML is inserted under the reviewed category and passes upstream npm test.',
        'The registry plus generated English and Chinese README diffs are reviewed before exact-file staging.',
        'The package, npm release, GitHub Release, tag, version, and source SHA are cross-checked.',
        'The PR body, repository topics, and all commands receive explicit human approval.',
      ],
      statement:
        'This artifact is a dry-run handoff only; generating it does not authorize or perform any GitHub, PR, topic, registry, or release operation.',
    },
  }
}

async function ensureOutputDirectory(root) {
  const canonicalRoot = await realpath(root)
  const lubanRoot = join(root, '.luban')
  try {
    const stats = await lstat(lubanRoot)
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error('Market handoff .luban path must be a real directory')
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    await mkdir(lubanRoot, { mode: 0o700 })
  }
  const canonicalLubanRoot = await realpath(lubanRoot)
  if (!pathIsWithin(canonicalRoot, canonicalLubanRoot)) {
    throw new Error('Market handoff output must stay inside the repository')
  }

  const outputDirectory = join(lubanRoot, 'market-handoffs')
  try {
    const stats = await lstat(outputDirectory)
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error('Market handoff output path must be a real directory')
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    await mkdir(outputDirectory, { mode: 0o700 })
  }
  const canonicalOutputDirectory = await realpath(outputDirectory)
  if (!pathIsWithin(canonicalRoot, canonicalOutputDirectory)) {
    throw new Error('Market handoff output must stay inside the repository')
  }
  return outputDirectory
}

export async function prepareMarketHandoff(options = {}) {
  if (typeof options.package !== 'string' || !PACKAGE_NAME.test(options.package)) {
    throw new Error('--package must be a dsh-luban-* package name')
  }
  if (
    typeof options.category !== 'string' ||
    !Object.hasOwn(UPSTREAM_MARKET_CATEGORIES, options.category)
  ) {
    throw new Error(
      `--category must be an upstream category: ${Object.keys(UPSTREAM_MARKET_CATEGORIES).join(', ')}`,
    )
  }
  if (options.write !== undefined && typeof options.write !== 'boolean') {
    throw new Error('write must be a boolean')
  }

  const root = resolve(options.root ?? REPOSITORY_ROOT)
  const injectedGitRunner = options.gitRunner !== undefined
  if (injectedGitRunner && typeof options.gitRunner !== 'function') {
    throw new Error('gitRunner must be a function')
  }
  if (options.write === true && injectedGitRunner) {
    throw new Error('Injected Git runners cannot write market handoff artifacts')
  }
  const candidate = await prepareMarketEntry({
    root,
    package: options.package,
    category: options.category,
    branch: 'mainline',
  })
  const version = candidate.sourceIdentity?.version
  if (typeof version !== 'string' || !SEMVER.test(version)) {
    throw new Error(`${options.package} must declare a valid SemVer version`)
  }
  const sourceRepository = `https://github.com/${candidate.sourceIdentity.owner}/${candidate.sourceIdentity.repository}`
  const git = localGitIdentity(root, options.gitRunner ?? defaultGitRunner, sourceRepository)
  const handoff = buildHandoff({
    package: options.package,
    version,
    category: options.category,
    description: candidate.entry.description.en,
    sourceIdentity: candidate.sourceIdentity,
    candidate,
    git,
    provenance: injectedGitRunner ? 'test-only' : 'local-clean-git',
  })
  const content = `${JSON.stringify(handoff, null, 2)}\n`
  assertSecretFree(content)
  const contentSha256 = sha256(content)
  const filename = `${options.package}-${version}-${git.sha.slice(0, 12)}-market-handoff.json`

  if (options.write !== true) {
    return { dryRun: true, filename, contentSha256, handoff, content }
  }

  const finalGit = localGitIdentity(root, defaultGitRunner, sourceRepository)
  if (
    finalGit.sha !== git.sha ||
    finalGit.branchRef !== git.branchRef ||
    finalGit.remote !== git.remote ||
    !finalGit.clean
  ) {
    throw new Error('Local Git identity changed while preparing the market handoff')
  }
  const outputDirectory = await ensureOutputDirectory(root)
  const output = join(outputDirectory, filename)
  await writeFile(output, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  return { dryRun: false, filename, output, contentSha256, handoff, content }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help === true) {
    console.log(
      'Usage: node scripts/release/prepare-market-handoff.mjs --package <dsh-luban-*> --category <upstream-slug> [--dry-run|--write]',
    )
    console.log(`Upstream categories: ${Object.keys(UPSTREAM_MARKET_CATEGORIES).join(', ')}`)
    console.log(
      'Default: print a deterministic preview. --write creates one ignored local artifact.',
    )
    return
  }
  const result = await prepareMarketHandoff(options)
  if (result.dryRun) console.log(result.content)
  else {
    console.log(
      JSON.stringify(
        {
          dryRun: false,
          output: relative(resolve(options.root ?? REPOSITORY_ROOT), result.output).replaceAll(
            sep,
            '/',
          ),
          contentSha256: result.contentSha256,
          externalWritesPerformed: false,
        },
        null,
        2,
      ),
    )
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(
      `prepare-market-handoff: ${error instanceof Error ? error.message : String(error)}`,
    )
    process.exitCode = 1
  })
}
