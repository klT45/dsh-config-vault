/**
 * HTTP plumbing shared by the vault routes: the loopback trust fence, bounded
 * JSON body reading, and the `{ ok, value } | { ok: false, error }` envelope
 * the browser half understands.
 *
 * The fence is deliberately strict: configuration snapshots contain settings
 * and (opt-in) credentials, so a LAN client, a reverse proxy or a cross-site
 * fetch must never reach a write route.
 */

/** Default cap for one action request body (snapshot/diff/restore args). */
export const DEFAULT_BODY_LIMIT = 256 * 1024
/** Cap for an import request that carries a whole bundle. */
export const IMPORT_BODY_LIMIT = 32 * 1024 * 1024

/**
 * Whether an address is IPv4 127/8.
 * @param {string} address
 */
function isIPv4Loopback(address) {
  const parts = address.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/**
 * Whether a socket remote address names the loopback range (127/8, ::1,
 * IPv4-mapped ::ffff:127/8).
 * @param {string|undefined} address
 */
export function isLoopbackAddress(address) {
  if (address === undefined) return false
  const normalized = address.toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) return isIPv4Loopback(normalized.slice('::ffff:'.length))
  return isIPv4Loopback(normalized)
}

/**
 * Whether a hostname names the loopback authority (`localhost`, `[::1]`,
 * 127/8).
 * @param {string} hostname
 */
function isLoopbackHostname(hostname) {
  return hostname === 'localhost' || hostname === '[::1]' || isIPv4Loopback(hostname)
}

/**
 * Whether the request provably originates on this machine. A request carrying
 * a forwarding header is refused: behind a proxy both the socket address and
 * the Host header describe the proxy, not the client.
 * @param {import('node:http').IncomingMessage} request
 */
export function isLoopbackRequest(request) {
  if (!isLoopbackAddress(request.socket?.remoteAddress)) return false
  if (request.headers['cf-connecting-ip'] !== undefined) return false
  if (request.headers['x-forwarded-for'] !== undefined) return false
  const host = request.headers.host
  if (typeof host !== 'string' || host === '') return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/**
 * Write one JSON response.
 * @param {import('node:http').ServerResponse} response
 * @param {number} status
 * @param {unknown} body
 */
export function writeJson(response, status, body) {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(payload)
}

/** Successful envelope. */
export const ok = value => ({ ok: true, value })

/**
 * Failure envelope.
 * @param {string} code
 * @param {string} message
 */
export const fail = (code, message) => ({ ok: false, error: { code, message } })

/**
 * Read a bounded JSON object body. An empty or malformed body becomes `{}` so
 * every action can validate its own arguments; oversized bodies throw a
 * `body-too-large` VaultError.
 * @param {import('node:http').IncomingMessage} request
 * @param {number} [limit]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function readJsonBody(request, limit = DEFAULT_BODY_LIMIT) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limit) {
      request.destroy()
      const error = new Error(`请求体超过上限（${Math.round(limit / 1024)} KiB）`)
      /** @type {any} */ (error).code = 'body-too-large'
      throw error
    }
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Build a POST-only, content-type-checked, loopback-fenced route handler.
 * Each action runs serially against the vault; unexpected throws are turned
 * into the error envelope rather than an unhandled rejection.
 * @param {(payload: Record<string, unknown>) => unknown|Promise<unknown>} action
 * @param {{ limit?: number }} [options]
 * @returns {(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => Promise<void>}
 */
export function postRoute(action, options = {}) {
  return async (request, response) => {
    if (!isLoopbackRequest(request)) {
      writeJson(response, 403, fail('forbidden', '仅允许本机回环地址访问'))
      return
    }
    if (request.method !== 'POST') {
      writeJson(response, 405, fail('method', '仅支持 POST'))
      return
    }
    const contentType = String(request.headers['content-type'] ?? '').toLowerCase()
    if (!contentType.startsWith('application/json')) {
      writeJson(response, 415, fail('content-type', '请求必须是 application/json'))
      return
    }
    try {
      const payload = await readJsonBody(request, options.limit)
      writeJson(response, 200, ok(await action(payload)))
    } catch (error) {
      const code = typeof (error)?.code === 'string' ? error.code : 'internal'
      const message = error instanceof Error ? error.message : String(error)
      writeJson(response, code === 'body-too-large' ? 413 : 200, fail(code, message))
    }
  }
}
