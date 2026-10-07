// Same-origin range-forwarding proxy backing /api/media-proxy. Serves the
// advanced engine's byte reads when the origin blocks cross-origin access.
// Bodies stream through; a 206 with Content-Range passes unchanged.
import { rejectDestination } from "./destinations"

const FORWARDED_REQUEST_HEADERS = [
  "range",
  "if-range",
  "if-none-match",
  "if-modified-since",
] as const

const PASSTHROUGH_RESPONSE_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "etag",
  "last-modified",
  "cache-control",
] as const

const CORS_ALLOW_HEADERS = "If-Modified-Since, If-None-Match, If-Range, Range"

const CORS_EXPOSE_HEADERS =
  "Accept-Ranges, Cache-Control, Content-Length, Content-Range, Content-Type, ETag, Last-Modified, Server-Timing"

const MAX_REDIRECT_HOPS = 5

const HEADER_DEADLINE_MS = 30_000

const RATE_LIMIT_PERIOD_SECONDS = 60

// Carries one request's proxy state to the single decision log at the end.
// host and path are copied from the parsed destination only — never from the
// raw url parameter — so signed query strings cannot reach the logs.
interface ProxyRun {
  method: string
  host: string | null
  path: string | null
  outcome: string
  redirectHops: number
  responseWaitMs: number
}

// Terminal rejections travel as values to the boundary handler in
// mediaProxy; they are normal product states, not exceptions to debug.
class ProxyRejection extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

function newProxyRun(request: Request): ProxyRun {
  return {
    method: request.method,
    host: null,
    path: null,
    outcome: "forwarded",
    redirectHops: 0,
    responseWaitMs: 0,
  }
}

function logProxyDecision(run: ProxyRun, status: number): void {
  console.log(JSON.stringify({ source: "media-proxy", status, ...run }))
}

function rateLimiter(env: Cloudflare.Env | undefined): RateLimit | undefined {
  return env?.RATE_LIMITER
}

async function withinRateLimit(
  limiter: RateLimit,
  request: Request
): Promise<boolean> {
  try {
    const key = request.headers.get("CF-Connecting-IP") ?? "unknown"

    return (await limiter.limit({ key })).success
  } catch (error) {
    // Fail open: the binding is a permissive, eventually consistent backstop
    // against relay abuse, so an unavailable limiter must not take playback
    // down with it.
    console.error(
      JSON.stringify({
        source: "media-proxy",
        event: "rate_limiter_unavailable",
        error: error instanceof Error ? error.message : String(error),
      })
    )

    return true
  }
}

function applyCors(headers: Headers): void {
  headers.set("Access-Control-Allow-Origin", "*")
  headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
  headers.set("Access-Control-Allow-Headers", CORS_ALLOW_HEADERS)
  headers.set("Access-Control-Expose-Headers", CORS_EXPOSE_HEADERS)
}

function errorResponse(
  status: number,
  code: string,
  message: string
): Response {
  const headers = new Headers({ "Content-Type": "application/json" })

  applyCors(headers)

  return new Response(JSON.stringify({ error: code, message }), {
    status,
    headers,
  })
}

function preflightResponse(): Response {
  const headers = new Headers()

  applyCors(headers)
  headers.set("Access-Control-Max-Age", "86400")
  headers.set("Allow", "GET, HEAD, OPTIONS")

  return new Response(null, { status: 204, headers })
}

function isRedirect(status: number): boolean {
  return (
    status === 301 ||
    status === 302 ||
    status === 303 ||
    status === 307 ||
    status === 308
  )
}

function forwardableHeaders(request: Request): Headers {
  const headers = new Headers()

  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name)

    if (value !== null) {
      headers.set(name, value)
    }
  }

  return headers
}

function requestedDestination(request: Request): URL {
  const rawUrl = new URL(request.url).searchParams.get("url")

  if (rawUrl === null || rawUrl.length === 0) {
    throw new ProxyRejection(
      400,
      "proxy_missing_url",
      "Pass the media URL as the url query parameter."
    )
  }

  try {
    return new URL(rawUrl)
  } catch {
    throw new ProxyRejection(
      400,
      "proxy_invalid_url",
      "The url query parameter is not a valid URL."
    )
  }
}

// Validates the next hop of a redirect and returns its destination.
function redirectDestination(response: Response, base: URL): URL {
  const location = response.headers.get("location")

  if (location === null) {
    throw new ProxyRejection(
      502,
      "proxy_redirect_without_location",
      "The media server returned a redirect without a destination."
    )
  }

  let next: URL

  try {
    next = new URL(location, base)
  } catch {
    throw new ProxyRejection(
      502,
      "proxy_redirect_invalid",
      "The media server redirected to an invalid URL."
    )
  }

  const rejection = rejectDestination(next)

  if (rejection !== null) {
    throw new ProxyRejection(403, "proxy_forbidden_destination", rejection)
  }

  return next
}

function createUpstreamFetcher(request: Request, run: ProxyRun) {
  const requestHeaders = forwardableHeaders(request)

  const singleFetch = async (destination: URL): Promise<Response> => {
    const controller = new AbortController()
    const startedAt = performance.now()

    const abortFromClient = () => controller.abort()
    request.signal.addEventListener("abort", abortFromClient, { once: true })

    // The deadline bounds waiting for response headers; once the body
    // streams, client disconnect is the only cancellation path.
    const deadline = setTimeout(() => controller.abort(), HEADER_DEADLINE_MS)

    try {
      return await fetch(destination, {
        method: request.method,
        headers: requestHeaders,
        redirect: "manual",
        signal: controller.signal,
      })
    } catch {
      throw new ProxyRejection(
        502,
        "proxy_upstream_unreachable",
        "The media server could not be reached."
      )
    } finally {
      run.responseWaitMs += performance.now() - startedAt
      clearTimeout(deadline)
      request.signal.removeEventListener("abort", abortFromClient)
    }
  }

  return async function fetchFollowingRedirects(
    destination: URL,
    hopsLeft: number
  ): Promise<Response> {
    const response = await singleFetch(destination)

    if (!isRedirect(response.status)) {
      return response
    }

    if (hopsLeft === 0) {
      throw new ProxyRejection(
        502,
        "proxy_too_many_redirects",
        "The media link redirected too many times."
      )
    }

    run.redirectHops += 1

    return fetchFollowingRedirects(
      redirectDestination(response, destination),
      hopsLeft - 1
    )
  }
}

function proxyResponse(upstream: Response, run: ProxyRun): Response {
  const headers = new Headers()

  for (const name of PASSTHROUGH_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name)

    if (value !== null) {
      headers.set(name, value)
    }
  }

  headers.set(
    "Server-Timing",
    `upstream;dur=${Math.max(0, run.responseWaitMs).toFixed(1)}`
  )

  applyCors(headers)

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  })
}

async function dispatchProxy(
  request: Request,
  env: Cloudflare.Env | undefined,
  run: ProxyRun
): Promise<Response> {
  if (request.method === "OPTIONS") {
    run.outcome = "preflight"

    return preflightResponse()
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    throw new ProxyRejection(
      405,
      "proxy_method_not_allowed",
      "Only GET, HEAD, and OPTIONS requests are proxied."
    )
  }

  const limiter = rateLimiter(env)

  if (limiter !== undefined && !(await withinRateLimit(limiter, request))) {
    throw new ProxyRejection(
      429,
      "proxy_rate_limited",
      "Too many proxy requests from this client; retry shortly."
    )
  }

  const destination = requestedDestination(request)

  run.host = destination.host
  run.path = destination.pathname

  const rejection = rejectDestination(destination)

  if (rejection !== null) {
    throw new ProxyRejection(403, "proxy_forbidden_destination", rejection)
  }

  const fetchUpstream = createUpstreamFetcher(request, run)

  return proxyResponse(await fetchUpstream(destination, MAX_REDIRECT_HOPS), run)
}

export async function mediaProxy(
  request: Request,
  env?: Cloudflare.Env
): Promise<Response> {
  const run = newProxyRun(request)

  let response: Response

  try {
    response = await dispatchProxy(request, env, run)
  } catch (rejection) {
    const known = rejection instanceof ProxyRejection

    if (!known) {
      // An unexpected failure must still surface as a CORS-capable JSON
      // error, and the real cause must reach the logs.
      console.error(
        JSON.stringify({
          source: "media-proxy",
          event: "proxy_internal_error",
          error:
            rejection instanceof Error ? rejection.message : String(rejection),
        })
      )
    }

    const status = known ? rejection.status : 500
    const code = known ? rejection.code : "proxy_internal_error"

    run.outcome = code
    response = errorResponse(
      status,
      code,
      known ? rejection.message : "The proxy failed unexpectedly."
    )

    if (status === 429) {
      response.headers.set("Retry-After", String(RATE_LIMIT_PERIOD_SECONDS))
    }
  }

  logProxyDecision(run, response.status)

  return response
}
