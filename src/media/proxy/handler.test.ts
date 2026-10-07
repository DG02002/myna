import { beforeEach, describe, expect, it } from "vitest"

import { mediaProxy } from "./handler"

const PROXY_ORIGIN = "https://playloom.test"

const UPSTREAM_ORIGIN = "https://upstream.test"

interface RecordedRequest {
  path: string
  method: string
  headers: Record<string, string>
}

function proxyRequest(mediaUrl: string, init?: RequestInit): Request {
  return new Request(
    `${PROXY_ORIGIN}/api/media-proxy?url=${encodeURIComponent(mediaUrl)}`,
    init
  )
}

function redirectUrl(target: string): string {
  return `${UPSTREAM_ORIGIN}/redirect?to=${encodeURIComponent(target)}`
}

async function recordedUpstreamRequests(): Promise<RecordedRequest[]> {
  const response = await fetch(`${UPSTREAM_ORIGIN}/recorded-requests`)

  return response.json<RecordedRequest[]>()
}

async function responseBody(response: Response): Promise<{
  error: string
  message: string
}> {
  return response.json<{ error: string; message: string }>()
}

beforeEach(async () => {
  await fetch(`${UPSTREAM_ORIGIN}/reset`, { method: "POST" })
})

describe("request validation", () => {
  it("answers CORS preflights without touching the upstream", async () => {
    const response = await mediaProxy(
      new Request(`${PROXY_ORIGIN}/api/media-proxy`, { method: "OPTIONS" })
    )

    expect(response.status).toBe(204)
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*")
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe(
      "GET, HEAD, OPTIONS"
    )
    expect(response.headers.get("Allow")).toBe("GET, HEAD, OPTIONS")
    expect(await recordedUpstreamRequests()).toEqual([])
  })

  it("refuses methods other than GET, HEAD, and OPTIONS", async () => {
    const response = await mediaProxy(
      new Request(`${PROXY_ORIGIN}/api/media-proxy?url=x`, { method: "POST" })
    )

    expect(response.status).toBe(405)
    expect((await responseBody(response)).error).toBe(
      "proxy_method_not_allowed"
    )
  })

  it("rejects a missing url parameter", async () => {
    const response = await mediaProxy(
      new Request(`${PROXY_ORIGIN}/api/media-proxy`)
    )

    expect(response.status).toBe(400)
    expect((await responseBody(response)).error).toBe("proxy_missing_url")
  })

  it("rejects an unparseable url parameter", async () => {
    const response = await mediaProxy(proxyRequest("not a url"))

    expect(response.status).toBe(400)
    expect((await responseBody(response)).error).toBe("proxy_invalid_url")
  })
})

describe("destination validation", () => {
  const FORBIDDEN_DESTINATIONS = [
    "http://upstream.test/video.mkv",
    "https://upstream.test:8443/video.mkv",
    "https://localhost/video.mkv",
    "https://media.localhost/video.mkv",
    "https://files.internal/video.mkv",
    "https://127.0.0.1/video.mkv",
    "https://10.1.2.3/video.mkv",
    "https://172.20.1.1/video.mkv",
    "https://192.168.1.10/video.mkv",
    "https://169.254.169.254/latest/meta-data",
    "https://100.64.1.2/video.mkv",
    "https://[::1]/video.mkv",
    "https://[fe80::1]/video.mkv",
    "https://[fc00::1]/video.mkv",
    "https://[::ffff:10.1.2.3]/video.mkv",
  ]

  for (const destination of FORBIDDEN_DESTINATIONS) {
    it(`rejects ${destination} before any upstream fetch`, async () => {
      const response = await mediaProxy(proxyRequest(destination))

      expect(response.status).toBe(403)
      expect((await responseBody(response)).error).toBe(
        "proxy_forbidden_destination"
      )
      expect(await recordedUpstreamRequests()).toEqual([])
    })
  }

  it("carries CORS headers on rejection responses", async () => {
    const response = await mediaProxy(proxyRequest("https://127.0.0.1/x"))

    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*")
  })
})

describe("redirect handling", () => {
  it("follows a redirect to an allowed destination", async () => {
    const response = await mediaProxy(
      proxyRequest(redirectUrl(`${UPSTREAM_ORIGIN}/video.mkv`))
    )

    expect(response.status).toBe(206)
    expect(response.headers.get("Content-Range")).toBe("bytes 0-10/5368709120")
  })

  it("rejects a redirect hop to a private address without fetching it", async () => {
    const response = await mediaProxy(
      proxyRequest(redirectUrl("https://169.254.169.254/latest/meta-data"))
    )

    expect(response.status).toBe(403)
    expect((await responseBody(response)).error).toBe(
      "proxy_forbidden_destination"
    )

    const requests = await recordedUpstreamRequests()

    expect(requests).toHaveLength(1)
    expect(requests[0]?.path).toBe("/redirect")
  })

  it("rejects a redirect hop that downgrades to http", async () => {
    const response = await mediaProxy(
      proxyRequest(redirectUrl("http://upstream.test/video.mkv"))
    )

    expect(response.status).toBe(403)
    expect((await responseBody(response)).error).toBe(
      "proxy_forbidden_destination"
    )
  })

  it("gives up after too many redirect hops", async () => {
    const response = await mediaProxy(
      proxyRequest(`${UPSTREAM_ORIGIN}/redirect-loop`)
    )

    expect(response.status).toBe(502)
    expect((await responseBody(response)).error).toBe(
      "proxy_too_many_redirects"
    )
  })

  it("reports a redirect without a location header", async () => {
    const response = await mediaProxy(
      proxyRequest(`${UPSTREAM_ORIGIN}/redirect-without-location`)
    )

    expect(response.status).toBe(502)
    expect((await responseBody(response)).error).toBe(
      "proxy_redirect_without_location"
    )
  })
})

describe("range forwarding", () => {
  it("forwards range requests and passes the slice response through", async () => {
    const response = await mediaProxy(
      proxyRequest(`${UPSTREAM_ORIGIN}/video.mkv`, {
        headers: {
          Range: "bytes=0-10",
          Cookie: "session=secret",
          Authorization: "Bearer secret",
        },
      })
    )

    expect(response.status).toBe(206)
    expect(response.headers.get("Content-Type")).toBe("video/x-matroska")
    expect(response.headers.get("Content-Range")).toBe("bytes 0-10/5368709120")
    expect(response.headers.get("Accept-Ranges")).toBe("bytes")
    expect(response.headers.get("ETag")).toBe('"mock-etag"')
    expect(response.headers.get("Access-Control-Expose-Headers")).toContain(
      "Content-Range"
    )
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe(
      "media-bytes"
    )

    const requests = await recordedUpstreamRequests()

    expect(requests).toHaveLength(1)
    expect(requests[0]?.headers.range).toBe("bytes=0-10")
    expect(requests[0]?.headers.cookie).toBeUndefined()
    expect(requests[0]?.headers.authorization).toBeUndefined()
  })
})

describe("body streaming", () => {
  it("returns before the upstream body completes and streams chunks as they arrive", async () => {
    // The gated route holds its second chunk until /release fires. The
    // proxy response resolving and the first chunk arriving while the gate
    // is still closed prove the body is streamed, never buffered.
    const response = await mediaProxy(
      proxyRequest(`${UPSTREAM_ORIGIN}/gated-video.mkv`)
    )

    expect(response.status).toBe(200)
    expect(response.body).toBeInstanceOf(ReadableStream)

    const reader = response.body!.getReader()

    const first = await reader.read()

    expect(new TextDecoder().decode(first.value)).toBe("first-chunk")
    expect(first.done).toBe(false)

    await fetch(`${UPSTREAM_ORIGIN}/release?gate=gated`)

    const second = await reader.read()

    expect(new TextDecoder().decode(second.value)).toBe("second-chunk")
    expect(await reader.read()).toEqual({ done: true, value: undefined })
  })

  it("reports upstream timing on success", async () => {
    const response = await mediaProxy(
      proxyRequest(`${UPSTREAM_ORIGIN}/video.mkv`)
    )

    expect(response.headers.get("Server-Timing")).toMatch(/^upstream;dur=/)
  })
})
