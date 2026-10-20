/**
 * Stable error type for every vault operation. Each error carries a machine
 * code the HTTP layer, the model-facing tool and the CLI all reuse, so a
 * caller never has to parse prose.
 */
export class VaultError extends Error {
  /**
   * @param {string} code stable identifier (`snapshot-not-found`, `path-escape`, ...)
   * @param {string} message human-readable explanation
   * @param {object} [details] extra structured context safe to return to callers
   */
  constructor(code, message, details = undefined) {
    super(message)
    this.name = 'VaultError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

/**
 * Normalize any thrown value into a stable `{ code, message }` pair.
 * @param {unknown} error
 * @returns {{ code: string, message: string }}
 */
export function toVaultError(error) {
  if (error instanceof VaultError) return { code: error.code, message: error.message }
  if (error instanceof Error) return { code: 'internal', message: error.message }
  return { code: 'internal', message: String(error) }
}

/**
 * Assert a condition, throwing a coded VaultError when it fails.
 * @param {unknown} condition
 * @param {string} code
 * @param {string} message
 */
export function invariant(condition, code, message) {
  if (!condition) throw new VaultError(code, message)
}
