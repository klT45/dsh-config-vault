/**
 * Passphrase encryption for exported bundles.
 *
 * AES-256-GCM with a scrypt-derived key; the envelope is JSON so a bundle
 * stays a single portable file and can carry its KDF parameters explicitly.
 * This protects a bundle at rest / in transit, not a running host: the
 * passphrase never touches disk.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { VaultError } from './errors.js'

/** Envelope format version. */
export const ENVELOPE_VERSION = 1
/** scrypt cost parameters: interactive-grade, ~100 ms on a desktop CPU. */
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, keyLen: 32 }

/**
 * Encrypt a JSON-serializable value with a passphrase.
 * @param {unknown} value
 * @param {string} passphrase
 * @returns {{ v: number, algo: 'aes-256-gcm', kdf: { name: 'scrypt', N: number, r: number, p: number, salt: string }, iv: string, tag: string, data: string }}
 */
export function encryptJson(value, passphrase) {
  assertPassphrase(passphrase)
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = scryptSync(passphrase, salt, SCRYPT.keyLen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 256 * 1024 * 1024 })
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8')
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    v: ENVELOPE_VERSION,
    algo: 'aes-256-gcm',
    kdf: { name: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString('base64') },
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: data.toString('base64'),
  }
}

/**
 * Decrypt an envelope produced by {@link encryptJson}.
 * @param {{ v: number, algo: string, kdf: { name: string, N: number, r: number, p: number, salt: string }, iv: string, tag: string, data: string }} envelope
 * @param {string} passphrase
 * @returns {unknown}
 */
export function decryptJson(envelope, passphrase) {
  assertPassphrase(passphrase)
  if (envelope === null || typeof envelope !== 'object') throw new VaultError('bundle-invalid', 'encrypted bundle envelope is missing')
  if (envelope.v !== ENVELOPE_VERSION) throw new VaultError('bundle-unsupported', `unsupported bundle envelope version ${String(envelope.v)}`)
  if (envelope.algo !== 'aes-256-gcm') throw new VaultError('bundle-unsupported', `unsupported encryption algorithm ${String(envelope.algo)}`)
  if (envelope.kdf === undefined || envelope.kdf.name !== 'scrypt') throw new VaultError('bundle-unsupported', 'unsupported key-derivation function')
  const salt = Buffer.from(envelope.kdf.salt, 'base64')
  const key = scryptSync(passphrase, salt, SCRYPT.keyLen, {
    N: envelope.kdf.N,
    r: envelope.kdf.r,
    p: envelope.kdf.p,
    maxmem: 256 * 1024 * 1024,
  })
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
  let plaintext
  try {
    plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()])
  } catch {
    throw new VaultError('bundle-decrypt-failed', '口令错误或文件已损坏')
  }
  try {
    return JSON.parse(plaintext.toString('utf8'))
  } catch {
    throw new VaultError('bundle-corrupt', '解密成功但内容不是合法 JSON')
  }
}

/**
 * Constant-time passphrase check helper (used when a bundle carries a
 * verifier; kept here so both encrypt/decrypt share one primitive).
 * @param {string} a
 * @param {string} b
 */
export function sameSecret(a, b) {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/**
 * Validate a passphrase before use.
 * @param {unknown} passphrase
 */
function assertPassphrase(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < 6) {
    throw new VaultError('passphrase-too-short', '口令至少需要 6 个字符')
  }
}
