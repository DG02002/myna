// Deterministic upstream origin for the proxy tests. Loaded by miniflare as
// its own worker and wired as the outbound service in vitest.config.ts, so
// every fetch from the test worker lands here instead of the network.
// Control routes (reset, recorded-requests, release) let tests steer and
// observe upstream behavior; media routes imitate a range-serving origin.

const heldBodies = new Map()

const recordedRequests = []

function recordRequest(request, url) {
  recordedRequests.push({
    path: url.pathname,
    method: request.method,
    headers: Object.fromEntries(request.headers),
  })
}

function redirectResponse(location) {
  return new Response(null, { status: 302, headers: { Location: location } })
}

// The body emits its first chunk immediately, then holds the stream open
// until the matching release request arrives.
function gatedVideoResponse() {
  const gate = new Promise((release) => {
    heldBodies.set("gated", release)
  })

  const stream = new ReadableStream({
    async pull(controller) {
      const encoder = new TextEncoder()

      controller.enqueue(encoder.encode("first-chunk"))

      await gate

      controller.enqueue(encoder.encode("second-chunk"))
      controller.close()
    },
  })

  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "video/x-matroska" },
  })
}

function rangeSliceResponse() {
  return new Response("media-bytes", {
    status: 206,
    headers: {
      "Content-Type": "video/x-matroska",
      "Content-Length": "11",
      "Content-Range": "bytes 0-10/5368709120",
      "Accept-Ranges": "bytes",
      ETag: '"mock-etag"',
    },
  })
}

export default {
  async fetch(request) {
    const url = new URL(request.url)

    if (url.pathname === "/reset") {
      for (const release of heldBodies.values()) {
        release()
      }

      heldBodies.clear()
      recordedRequests.length = 0

      return new Response(null, { status: 204 })
    }

    if (url.pathname === "/recorded-requests") {
      return Response.json(recordedRequests)
    }

    if (url.pathname === "/release") {
      const gate = url.searchParams.get("gate")
      const release = heldBodies.get(gate)

      if (release !== undefined) {
        heldBodies.delete(gate)
        release()
      }

      return new Response(null, { status: 204 })
    }

    recordRequest(request, url)

    if (url.pathname === "/redirect") {
      return redirectResponse(url.searchParams.get("to") ?? "/")
    }

    if (url.pathname === "/redirect-loop") {
      return redirectResponse(url.pathname)
    }

    if (url.pathname === "/redirect-without-location") {
      return new Response(null, { status: 302 })
    }

    if (url.pathname === "/gated-video.mkv") {
      return gatedVideoResponse()
    }

    if (url.pathname === "/video.mkv") {
      return rangeSliceResponse()
    }

    return new Response("upstream path not mocked", { status: 404 })
  },
}
