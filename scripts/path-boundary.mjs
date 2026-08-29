import { constants } from 'node:fs'
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

function errorCode(error) {
  return typeof error === 'object' && error !== null ? error.code : undefined
}

export function pathIsWithin(root, target) {
  const rel = relative(resolve(root), resolve(target))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

async function canonicalPath(target) {
  let cursor = resolve(target)
  const suffix = []
  for (;;) {
    try {
      return resolve(await realpath(cursor), ...suffix.reverse())
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error
      const parent = dirname(cursor)
      if (parent === cursor) throw error
      suffix.push(basename(cursor))
      cursor = parent
    }
  }
}

async function rejectLinkedSegments(root, target, label) {
  const rel = relative(resolve(root), resolve(target))
  let cursor = resolve(root)
  for (const segment of rel.split(/[\\/]/u).filter(Boolean)) {
    cursor = resolve(cursor, segment)
    try {
      if ((await lstat(cursor)).isSymbolicLink()) {
        throw new Error(`${label} cannot traverse a symbolic link or junction: ${cursor}`)
      }
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return
      throw error
    }
  }
}

/** Resolve a child path while rejecting lexical and filesystem-identity escapes. */
export async function safeChildPath(root, target, label) {
  const lexicalRoot = resolve(root)
  const lexicalTarget = resolve(target)
  if (lexicalRoot === lexicalTarget || !pathIsWithin(lexicalRoot, lexicalTarget)) {
    throw new Error(`${label} must be a child of its configured root: ${lexicalTarget}`)
  }
  const [canonicalRoot, canonicalTarget] = await Promise.all([
    canonicalPath(lexicalRoot),
    canonicalPath(lexicalTarget),
  ])
  if (!pathIsWithin(canonicalRoot, canonicalTarget)) {
    throw new Error(`${label} resolves outside its configured root: ${lexicalTarget}`)
  }
  await rejectLinkedSegments(lexicalRoot, lexicalTarget, label)
  return { root: canonicalRoot, target: canonicalTarget }
}

async function captureIdentity(target, kind, label, allowLinkedTarget = false) {
  const lexicalPath = resolve(target)
  const lexicalInfo = await lstat(lexicalPath, { bigint: true })
  if (!allowLinkedTarget && lexicalInfo.isSymbolicLink()) {
    throw new Error(`${label} cannot be a symbolic link or junction: ${lexicalPath}`)
  }
  const canonical = resolve(await realpath(lexicalPath))
  const info = canonical === lexicalPath ? lexicalInfo : await lstat(canonical, { bigint: true })
  if (kind === 'directory' ? !info.isDirectory() : !info.isFile()) {
    throw new Error(`${label} is not a ${kind}: ${lexicalPath}`)
  }
  return Object.freeze({ path: canonical, dev: info.dev, ino: info.ino, kind })
}

async function assertIdentity(target, expected, label, allowRelocation = false) {
  const current = await captureIdentity(target, expected.kind, label)
  if (
    current.dev !== expected.dev ||
    current.ino !== expected.ino ||
    (!allowRelocation && current.path !== expected.path)
  ) {
    throw new Error(`${label} changed filesystem identity: ${resolve(target)}`)
  }
  return current
}

async function assertAbsent(target, label) {
  try {
    await lstat(target)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return
    throw error
  }
  throw new Error(`Refusing to overwrite existing ${label}: ${target}`)
}

async function ensureSafeDirectory(root, target, label) {
  const lexicalRoot = resolve(root)
  const lexicalTarget = resolve(target)
  if (!pathIsWithin(lexicalRoot, lexicalTarget)) {
    throw new Error(`${label} must stay inside its configured root: ${lexicalTarget}`)
  }
  const rootIdentity = await captureIdentity(lexicalRoot, 'directory', `${label} root`, true)
  const rel = relative(lexicalRoot, lexicalTarget)
  let cursor = rootIdentity.path
  let cursorIdentity = rootIdentity
  for (const segment of rel.split(/[\\/]/u).filter(Boolean)) {
    await assertIdentity(cursor, cursorIdentity, label)
    const next = resolve(cursor, segment)
    try {
      await mkdir(next)
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error
    }
    const safe = await safeChildPath(rootIdentity.path, next, label)
    cursorIdentity = await captureIdentity(safe.target, 'directory', label)
    await assertIdentity(rootIdentity.path, rootIdentity, `${label} root`)
    cursor = cursorIdentity.path
  }
  return { path: cursor, identity: cursorIdentity, rootIdentity }
}

class StagedDirectoryPublisher {
  #published = false
  #files = new Map()
  #directories = new Map()

  constructor(rootIdentity, parentIdentity, stagingIdentity, finalPath, label) {
    this.rootIdentity = rootIdentity
    this.parentIdentity = parentIdentity
    this.stagingIdentity = stagingIdentity
    this.finalPath = finalPath
    this.label = label
    this.#directories.set(stagingIdentity.path, stagingIdentity)
  }

  get stagingPath() {
    return this.stagingIdentity.path
  }

  async writeText(relativePath, content) {
    const destination = await this.#prepareDestination(relativePath)
    await writeFile(destination, content, { encoding: 'utf8', flag: 'wx' })
    const identity = await captureIdentity(destination, 'file', `${this.label} output`)
    this.#files.set(identity.path, identity)
    await this.#validateForWrite()
  }

  async copyExclusive(source, relativePath) {
    const destination = await this.#prepareDestination(relativePath)
    await copyFile(source, destination, constants.COPYFILE_EXCL)
    const identity = await captureIdentity(destination, 'file', `${this.label} output`)
    this.#files.set(identity.path, identity)
    await this.#validateForWrite()
  }

  async publish() {
    await this.#validateForWrite()
    for (const [path, identity] of this.#files) {
      await assertIdentity(path, identity, `${this.label} output`)
    }
    await this.#validateForWrite()
    await rename(this.stagingIdentity.path, this.finalPath)
    this.#published = true
    const published = await assertIdentity(
      this.finalPath,
      this.stagingIdentity,
      `${this.label} published directory`,
      true,
    )
    await assertIdentity(this.rootIdentity.path, this.rootIdentity, `${this.label} root`)
    await assertIdentity(this.parentIdentity.path, this.parentIdentity, `${this.label} parent`)
    const safe = await safeChildPath(this.rootIdentity.path, published.path, this.label)
    if (safe.target !== published.path) {
      throw new Error(`${this.label} published at an unexpected canonical path`)
    }
    return published.path
  }

  async abort() {
    if (this.#published) return false
    try {
      await this.#validateHierarchy()
      for (const [path, identity] of [...this.#files].reverse()) {
        await assertIdentity(path, identity, `${this.label} cleanup file`)
        await unlink(path)
      }
      const directories = [...this.#directories].filter(
        ([path]) => path !== this.stagingIdentity.path,
      )
      for (const [path, identity] of directories.reverse()) {
        await assertIdentity(path, identity, `${this.label} cleanup directory`)
        await rmdir(path)
      }
      await assertIdentity(
        this.stagingIdentity.path,
        this.stagingIdentity,
        `${this.label} staging directory`,
      )
      await rmdir(this.stagingIdentity.path)
      return true
    } catch {
      // Fail closed: an identity mismatch leaves the unpredictable staging path untouched.
      return false
    }
  }

  async #prepareDestination(relativePath) {
    const destination = resolve(this.stagingIdentity.path, relativePath)
    if (!pathIsWithin(this.stagingIdentity.path, destination) || destination === this.stagingPath) {
      throw new Error(`${this.label} output must stay inside staging: ${relativePath}`)
    }
    const relativeParent = relative(this.stagingIdentity.path, dirname(destination))
    let cursor = this.stagingIdentity.path
    for (const segment of relativeParent.split(/[\\/]/u).filter(Boolean)) {
      await this.#validateForWrite()
      const next = resolve(cursor, segment)
      let identity = this.#directories.get(next)
      if (identity === undefined) {
        try {
          await mkdir(next)
        } catch (error) {
          if (errorCode(error) === 'EEXIST') {
            throw new Error(`${this.label} staging path appeared unexpectedly: ${next}`)
          }
          throw error
        }
        const safe = await safeChildPath(this.stagingIdentity.path, next, `${this.label} staging`)
        identity = await captureIdentity(safe.target, 'directory', `${this.label} staging`)
        this.#directories.set(identity.path, identity)
      } else {
        await assertIdentity(next, identity, `${this.label} staging`)
      }
      cursor = identity.path
    }
    await this.#validateForWrite()
    const safe = await safeChildPath(this.stagingIdentity.path, destination, `${this.label} output`)
    await assertAbsent(safe.target, `${this.label} output`)
    await this.#validateForWrite()
    return safe.target
  }

  async #validateForWrite() {
    await this.#validateHierarchy()
    const safe = await safeChildPath(this.rootIdentity.path, this.finalPath, this.label)
    if (safe.target !== this.finalPath) {
      throw new Error(`${this.label} final path changed canonical identity`)
    }
    await assertAbsent(this.finalPath, this.label)
    await this.#validateHierarchy()
  }

  async #validateHierarchy() {
    await assertIdentity(this.rootIdentity.path, this.rootIdentity, `${this.label} root`)
    await assertIdentity(this.parentIdentity.path, this.parentIdentity, `${this.label} parent`)
    if (this.parentIdentity.path !== this.rootIdentity.path) {
      await safeChildPath(this.rootIdentity.path, this.parentIdentity.path, `${this.label} parent`)
    }
    await assertIdentity(
      this.stagingIdentity.path,
      this.stagingIdentity,
      `${this.label} staging directory`,
    )
    await safeChildPath(
      this.parentIdentity.path,
      this.stagingIdentity.path,
      `${this.label} staging directory`,
    )
    for (const [path, identity] of this.#directories) {
      if (path === this.stagingIdentity.path) continue
      await assertIdentity(path, identity, `${this.label} staging directory`)
      await safeChildPath(this.stagingIdentity.path, path, `${this.label} staging directory`)
    }
  }
}

/** Create an unpredictable sibling staging directory for atomic directory publication. */
export async function createStagedDirectoryPublisher(root, target, label) {
  const lexicalRoot = resolve(root)
  const lexicalTarget = resolve(target)
  if (lexicalRoot === lexicalTarget || !pathIsWithin(lexicalRoot, lexicalTarget)) {
    throw new Error(`${label} must be a child of its configured root: ${lexicalTarget}`)
  }
  const parent = await ensureSafeDirectory(lexicalRoot, dirname(lexicalTarget), `${label} parent`)
  const finalPath = resolve(parent.path, basename(lexicalTarget))
  const safeFinal = await safeChildPath(parent.rootIdentity.path, finalPath, label)
  await assertAbsent(safeFinal.target, label)
  await assertIdentity(parent.rootIdentity.path, parent.rootIdentity, `${label} root`)
  await assertIdentity(parent.identity.path, parent.identity, `${label} parent`)
  const stagingPath = await mkdtemp(join(parent.path, `.${basename(finalPath)}-stage-`))
  const safeStaging = await safeChildPath(parent.path, stagingPath, `${label} staging directory`)
  const stagingIdentity = await captureIdentity(
    safeStaging.target,
    'directory',
    `${label} staging directory`,
  )
  await assertIdentity(parent.rootIdentity.path, parent.rootIdentity, `${label} root`)
  await assertIdentity(parent.identity.path, parent.identity, `${label} parent`)
  return new StagedDirectoryPublisher(
    parent.rootIdentity,
    parent.identity,
    stagingIdentity,
    safeFinal.target,
    label,
  )
}
