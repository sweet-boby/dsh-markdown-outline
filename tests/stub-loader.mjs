/**
 * Resolve the Host-only packages this plugin imports to local stubs.
 *
 * `index.js` is a Host plugin: it imports `@deepseek-ai/dsh-session` for the
 * record writer its mutating routes use. That package belongs to the running
 * Harness, so it is not installed beside this repository. Registering a tiny
 * stub keeps the pure rules under test without weakening the production
 * import — the plugin keeps the real dependency at runtime.
 */

import { register } from 'node:module'
import { pathToFileURL } from 'node:url'

const STUBS = {
  '@deepseek-ai/dsh-session': pathToFileURL(new URL('./stub-dsh-session.mjs', import.meta.url).pathname).href,
  '@deepseek-ai/dsh-session/repair': pathToFileURL(new URL('./stub-dsh-session.mjs', import.meta.url).pathname).href,
}

/**
 * Rewrite a Host-only specifier to its stub.
 * @param {string} specifier - the requested module.
 * @param {object} context - Node's resolve context.
 * @param {Function} nextResolve - the default resolver.
 * @returns {object} the resolution.
 */
export async function resolve(specifier, context, nextResolve) {
  const stub = STUBS[specifier]
  if (stub !== undefined) return { url: stub, shortCircuit: true }
  return nextResolve(specifier, context)
}
