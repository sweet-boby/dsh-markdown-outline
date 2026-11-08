/**
 * Stand-in for `@deepseek-ai/dsh-session`.
 *
 * The unit tests exercise the pure rules in `index.js`; the record writer is
 * only reached by the HTTP routes, which these tests do not drive. Recording
 * the calls keeps the seam observable if a test ever wants to assert on it.
 */

/** Every record appended through this stub, in call order. */
export const appended = []

/**
 * Record one append request.
 * @param {object} session - the target session.
 * @param {string} type - plugin record type.
 * @param {object} data - JSON payload.
 * @returns {number} the next sequence number.
 */
export function appendPluginRecord(session, type, data) {
  appended.push({ session, type, data })
  return appended.length - 1
}
