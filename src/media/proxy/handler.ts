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
  "Accept-Ranges, Cache-Control, Content-Length, Content-Range, Content-Type, ETag, Last-Modified"

const MAX_REDIRECT_HOPS = 5

const HEADER_DEADLINE_MS = 30_000

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

// Validates the next hop of a redirect. Returns the destination, or a
// complete error response when the hop is invalid or forbidden.
function redirectDestination(response: Response, base: URL): URL | Response {
  const location = response.headers.get("location")

  if (location === null) {
    return errorResponse(
      502,
      "proxy_redirect_without_location",
      "The media server returned a redirect without a destination."
    )
  }

  let next: URL

  try {
    next = new URL(location, base)
  } catch {
    return errorResponse(
      502,
      "proxy_redirect_invalid",
      "The media server redirected to an invalid URL."
    )
  }

  const rejection = rejectDestination(next)

  if (rejection !== null) {
    return errorResponse(403, "proxy_forbidden_destination", rejection)
  }

  return next
}

function createUpstreamFetcher(
  method: string,
  requestHeaders: Headers,
  clientSignal: AbortSignal
) {
  const singleFetch = async (destination: URL): Promise<Response> => {
    const controller = new AbortController()

    const abortFromClient = () => controller.abort()
    clientSignal.addEventListener("abort", abortFromClient, { once: true })

    // The deadline bounds waiting for response headers; once the body
    // streams, client disconnect is the only cancellation path.
    const deadline = setTimeout(() => controller.abort(), HEADER_DEADLINE_MS)

    try {
      return await fetch(destination, {
        method,
        headers: requestHeaders,
        redirect: "manual",
        signal: controller.signal,
      })
    } catch {
      return errorResponse(
        502,
        "proxy_upstream_unreachable",
        "The media server could not be reached."
      )
    } finally {
      clearTimeout(deadline)
      clientSignal.removeEventListener("abort", abortFromClient)
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
      return errorResponse(
        502,
        "proxy_too_many_redirects",
        "The media link redirected too many times."
      )
    }

    const next = redirectDestination(response, destination)

    if (next instanceof Response) {
      return next
    }

    return fetchFollowingRedirects(next, hopsLeft - 1)
  }
}

function proxyResponse(upstream: Response): Response {
  const headers = new Headers()

  for (const name of PASSTHROUGH_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name)

    if (value !== null) {
      headers.set(name, value)
    }
  }

  applyCors(headers)

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  })
}

export async function mediaProxy(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") {
    return preflightResponse()
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return errorResponse(
      405,
      "proxy_method_not_allowed",
      "Only GET, HEAD, and OPTIONS requests are proxied."
    )
  }

  const rawUrl = new URL(request.url).searchParams.get("url")

  if (rawUrl === null || rawUrl.length === 0) {
    return errorResponse(
      400,
      "proxy_missing_url",
      "Pass the media URL as the url query parameter."
    )
  }

  let destination: URL

  try {
    destination = new URL(rawUrl)
  } catch {
    return errorResponse(
      400,
      "proxy_invalid_url",
      "The url query parameter is not a valid URL."
    )
  }

  const rejection = rejectDestination(destination)

  if (rejection !== null) {
    return errorResponse(403, "proxy_forbidden_destination", rejection)
  }

  const fetchUpstream = createUpstreamFetcher(
    request.method,
    forwardableHeaders(request),
    request.signal
  )

  const upstream = await fetchUpstream(destination, MAX_REDIRECT_HOPS)

  return proxyResponse(upstream)
}
