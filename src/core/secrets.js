/**
 * Secret awareness. The vault never tries to be a password manager: it
 * excludes whole secret files by default and, for shared config files that
 * may embed a key, it masks the value in every model/UI-facing view while the
 * stored payload keeps the original bytes. Masking is therefore display-only
 * and can never corrupt a restore.
 */

/** Keys whose value must never be rendered, in YAML/JSON/properties shapes. */
const SECRET_KEY_PATTERN = /(api[_-]?key|apikey|access[_-]?key|secret[_-]?key|client[_-]?secret|private[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|id[_-]?token|bearer|authorization|cookie|password|passwd|passphrase|session[_-]?key)/i

/** Inline values that look like provider credentials even without a key name. */
const SECRET_VALUE_PATTERN = /\b(sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,})\b/

/** Placeholder written where a secret value was masked. */
export const MASK = '••••••'

/**
 * Whether a key name carries a secret value.
 * @param {string} key
 */
export function isSecretKey(key) {
  return SECRET_KEY_PATTERN.test(key)
}

/**
 * Whether a whole line/key-value encodes a secret. Used to flag a manifest
 * file as secret-bearing (so export forces encryption attention) without
 * reading anything into a log.
 * @param {string} text
 */
export function containsSecret(text) {
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    if (lineLooksSecret(line)) return true
  }
  return SECRET_VALUE_PATTERN.test(text)
}

/**
 * Whether one line assigns a secret-looking key with a non-empty value.
 * @param {string} line
 */
function lineLooksSecret(line) {
  const match = /^\s*["']?([A-Za-z0-9_.-]+)["']?\s*[:=]\s*(.*)$/.exec(line)
  if (match === null) return false
  const [, key, rawValue] = match
  if (!isSecretKey(key)) return false
  const value = rawValue.replace(/^["']|["',]\s*$/g, '').trim()
  return value !== '' && value !== '~' && value !== 'null' && !/^\$\{?[A-Z0-9_]+\}?$/.test(value)
}

/**
 * Mask secret values in a text blob for display. Structure (indentation, key
 * names, comments, line order) is preserved so the diff still reads like the
 * original file; only the values change.
 * @param {string} text
 * @returns {string}
 */
export function maskText(text) {
  return text
    .split(/\r?\n/)
    .map((line) => {
      if (line.trimStart().startsWith('#')) return maskInlineSecrets(line)
      const match = /^(\s*(?:-\s+)?["']?([A-Za-z0-9_.-]+)["']?\s*[:=]\s*)(.*)$/.exec(line)
      if (match !== null && isSecretKey(match[2])) {
        const value = match[3].trim()
        if (value === '' || value === '~' || value === 'null') return line
        const quote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : ''
        return `${match[1]}${quote}${MASK}${quote}`
      }
      return maskInlineSecrets(line)
    })
    .join('\n')
}

/**
 * Replace inline credential-looking tokens anywhere in one line.
 * @param {string} line
 */
function maskInlineSecrets(line) {
  return line.replace(SECRET_VALUE_PATTERN, MASK)
}

/**
 * Mask a JSON value by key name, recursively. Arrays are masked element-wise
 * (a key's array of keys is itself secret).
 * @param {unknown} value
 * @param {string} [key]
 * @returns {unknown}
 */
export function maskJsonValue(value, key = '') {
  if (isSecretKey(key)) return MASK
  if (Array.isArray(value)) return value.map(item => maskJsonValue(item, key))
  if (value !== null && typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {}
    for (const [childKey, childValue] of Object.entries(value)) {
      out[childKey] = maskJsonValue(childValue, childKey)
    }
    return out
  }
  if (typeof value === 'string' && SECRET_VALUE_PATTERN.test(value)) return MASK
  return value
}

/**
 * Count how many secret-bearing lines a text contains (diagnostics only; the
 * count is safe to report, the values never leave the vault).
 * @param {string} text
 */
export function countSecretLines(text) {
  let count = 0
  for (const line of text.split(/\r?\n/)) {
    if (lineLooksSecret(line) || SECRET_VALUE_PATTERN.test(line)) count += 1
  }
  return count
}
