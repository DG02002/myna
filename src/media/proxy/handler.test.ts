import { beforeEach, describe, expect, it, vi } from "vitest"

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

interface LimiterStub {
  limiter: RateLimit
  keys: string[]
}

function limiterStub(behavior: "allow" | "deny" | "fail"): LimiterStub {
  const keys: string[] = []

  const limiter: RateLimit = {
    async limit(options) {
      keys.push(options.key)

      if (behavior === "deny") {
        return { success: false }
      }

      if (behavior === "fail") {
        throw new Error("limiter unavailable")
      }

      return { success: true }
    },
  }

  return { limiter, keys }
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

describe("rate limiting", () => {
  it("keys the limit by client IP and allows requests within it", async () => {
    const { limiter, keys } = limiterStub("allow")

    const response = await mediaProxy(
      proxyRequest(`${UPSTREAM_ORIGIN}/video.mkv`, {
        headers: { "CF-Connecting-IP": "203.0.113.7" },
      }),
      { RATE_LIMITER: limiter }
    )

    expect(response.status).toBe(206)
    expect(keys).toEqual(["203.0.113.7"])
  })

  it("treats a missing client IP as one shared key", async () => {
    const { limiter, keys } = limiterStub("allow")

    const response = await mediaProxy(
      proxyRequest(`${UPSTREAM_ORIGIN}/video.mkv`),
      { RATE_LIMITER: limiter }
    )

    expect(response.status).toBe(206)
    expect(keys).toEqual(["unknown"])
  })

  it("returns 429 with Retry-After without reaching the upstream", async () => {
    const { limiter, keys } = limiterStub("deny")

    const response = await mediaProxy(
      proxyRequest(`${UPSTREAM_ORIGIN}/video.mkv`),
      { RATE_LIMITER: limiter }
    )

    expect(response.status).toBe(429)
    expect(response.headers.get("Retry-After")).toBe("60")
    expect((await responseBody(response)).error).toBe("proxy_rate_limited")
    expect(keys).toHaveLength(1)
    expect(await recordedUpstreamRequests()).toEqual([])
  })

  it("fails open when the limiter errors", async () => {
    const { limiter, keys } = limiterStub("fail")

    const response = await mediaProxy(
      proxyRequest(`${UPSTREAM_ORIGIN}/video.mkv`),
      { RATE_LIMITER: limiter }
    )

    expect(response.status).toBe(206)
    expect(keys).toHaveLength(1)
  })

  it("skips limiting when the binding is absent", async () => {
    const response = await mediaProxy(
      proxyRequest(`${UPSTREAM_ORIGIN}/video.mkv`)
    )

    expect(response.status).toBe(206)
  })

  it("does not count preflights or refused methods", async () => {
    const { limiter, keys } = limiterStub("allow")

    await mediaProxy(
      new Request(`${PROXY_ORIGIN}/api/media-proxy`, { method: "OPTIONS" }),
      { RATE_LIMITER: limiter }
    )
    await mediaProxy(
      new Request(`${PROXY_ORIGIN}/api/media-proxy?url=x`, { method: "POST" }),
      { RATE_LIMITER: limiter }
    )

    expect(keys).toEqual([])
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

describe("decision logging", () => {
  interface DecisionEntry {
    source: string
    status: number
    method: string
    host: string | null
    path: string | null
    outcome: string
    redirectHops: number
  }

  function decisionLogs(spy: ReturnType<typeof vi.spyOn>): DecisionEntry[] {
    const entries: DecisionEntry[] = []

    for (const call of spy.mock.calls) {
      // SAFETY: the media proxy logs JSON.stringify output whose shape is
      // the handler's own ProxyRun plus source and status fields.
      const entry = JSON.parse(call[0]) as DecisionEntry

      if (entry.source === "media-proxy") {
        entries.push(entry)
      }
    }

    return entries
  }

  it("logs one decision per forwarded request without the query string", async () => {
    const log = vi.spyOn(console, "log")

    try {
      const response = await mediaProxy(
        proxyRequest(
          `${UPSTREAM_ORIGIN}/video.mkv?token=signed-secret&expiry=42`
        )
      )

      expect(response.status).toBe(206)

      const entries = decisionLogs(log)

      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({
        source: "media-proxy",
        status: 206,
        method: "GET",
        host: "upstream.test",
        path: "/video.mkv",
        outcome: "forwarded",
      })

      expect(log.mock.calls[0]?.[0]).not.toContain("token")
      expect(log.mock.calls[0]?.[0]).not.toContain("?")
    } finally {
      log.mockRestore()
    }
  })

  it("counts followed redirect hops", async () => {
    const log = vi.spyOn(console, "log")

    try {
      const response = await mediaProxy(
        proxyRequest(redirectUrl(`${UPSTREAM_ORIGIN}/video.mkv`))
      )

      expect(response.status).toBe(206)
      expect(decisionLogs(log)[0]?.redirectHops).toBe(1)
    } finally {
      log.mockRestore()
    }
  })

  it("logs the rejected destination itself, still without its query", async () => {
    const log = vi.spyOn(console, "log")

    try {
      const response = await mediaProxy(
        proxyRequest("https://169.254.169.254/latest/meta-data?token=secret")
      )

      expect(response.status).toBe(403)

      const entries = decisionLogs(log)

      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({
        status: 403,
        host: "169.254.169.254",
        path: "/latest/meta-data",
        outcome: "proxy_forbidden_destination",
      })

      expect(log.mock.calls[0]?.[0]).not.toContain("token")
    } finally {
      log.mockRestore()
    }
  })

  it("logs rate limited and preflight decisions", async () => {
    const log = vi.spyOn(console, "log")

    try {
      const { limiter } = limiterStub("deny")

      const limited = await mediaProxy(
        proxyRequest(`${UPSTREAM_ORIGIN}/video.mkv`),
        { RATE_LIMITER: limiter }
      )

      expect(limited.status).toBe(429)

      const preflight = await mediaProxy(
        new Request(`${PROXY_ORIGIN}/api/media-proxy`, { method: "OPTIONS" })
      )

      expect(preflight.status).toBe(204)

      const entries = decisionLogs(log)

      expect(entries.map((entry) => entry.outcome)).toEqual([
        "proxy_rate_limited",
        "preflight",
      ])
    } finally {
      log.mockRestore()
    }
  })
})
