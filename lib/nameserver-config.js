import { readApiConfig } from './config.js'

/**
 * Nameserver topology lives in the data store alongside zones, not in the
 * server's bootstrap config. This module bridges the two: it reads nameservers
 * out of the store for the supervisor, and migrates any that are still sitting
 * in an older nictool.json.
 *
 * The supervisor needs the store connection as well as the records — the DNS
 * engines stream zone data straight from the store rather than through the API,
 * so this is the one place the server legitimately reads the API's config.
 */

async function openRepo() {
  // Imported lazily: the API resolves its store backend at module load, so this
  // must happen after NICTOOL_CONF_DIR is set.
  const mod = await import('@nictool/api/lib/nameserver/index.js')
  return mod.default
}

/**
 * A NicTool install lists every nameserver it knows about, most of which are
 * export targets running elsewhere. Only records carrying listen sockets are
 * ones this host is being asked to serve.
 */
export function runnableHere(nameservers) {
  return nameservers.filter((ns) => Array.isArray(ns.listen) && ns.listen.length > 0)
}

export async function loadFromStore() {
  const repo = await openRepo()
  return runnableHere(await repo.get({}))
}

async function saveToStore(nameservers) {
  if (!Array.isArray(nameservers) || !nameservers.length) return 0

  const repo = await openRepo()
  const existing = await repo.get({})
  const nextId = existing.reduce((max, ns) => Math.max(max, ns.id ?? 0), 0) + 1

  let created = 0
  for (const [i, ns] of nameservers.entries()) {
    if (existing.some((e) => e.name === ns.name)) continue
    await repo.create({ id: ns.id ?? nextId + i, ...ns })
    created++
  }
  return created
}

/**
 * Assemble what NameserverSupervisor.start() needs: the store connection plus
 * the nameserver records. Falls back to any records still carried in the
 * bootstrap config when the store cannot be reached.
 */
export async function resolveNameserverConfig(configDir, bootstrap) {
  const apiConfig = await readApiConfig(configDir)
  const store = apiConfig?.store ?? null
  const carried = Array.isArray(bootstrap?.nameserver) ? bootstrap.nameserver : []

  if (!store) return { store, nameserver: carried }

  try {
    const stored = await loadFromStore()
    return { store, nameserver: stored.length ? stored : carried }
  } catch (err) {
    console.warn(`Could not read nameservers from the store: ${err.message}`)
    return { store, nameserver: carried }
  }
}

/**
 * Move nameservers out of the bootstrap config and into the store, once. The
 * bootstrap file is only rewritten after the store write succeeds, so a failure
 * leaves the records where they are rather than losing them.
 */
export async function migrateNameservers(configDir, bootstrap, writeBootstrap) {
  const carried = Array.isArray(bootstrap?.nameserver) ? bootstrap.nameserver : []
  if (!carried.length) return bootstrap

  try {
    const created = await saveToStore(carried)
    const { nameserver: _moved, ...rest } = bootstrap
    await writeBootstrap(configDir, rest)
    console.log(`Moved ${created} nameserver(s) from nictool.json into the data store`)
    return rest
  } catch (err) {
    console.warn(`Could not move nameservers into the store: ${err.message}`)
    return bootstrap
  }
}
