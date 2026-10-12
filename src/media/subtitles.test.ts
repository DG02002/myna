import assert from "node:assert/strict"
import { test } from "node:test"

import {
  loadSubtitleCues,
  parseSubtitleCues,
  subtitleCueDisplayText,
  subtitleTrackName,
} from "./subtitles"

function inputUrl(input: RequestInfo | URL): string {
  if (input instanceof Request) {
    return input.url
  }

  if (input instanceof URL) {
    return input.href
  }

  return input
}

void test("parses SRT cues with comma decimals and optional hours", () => {
  assert.deepEqual(parseSubtitleCues("1\n00:01,25 --> 00:03,5\nHello\n"), [
    { startTime: 1.25, endTime: 3.5, text: "Hello" },
  ])
})

void test("parses WebVTT and skips headers, notes, and malformed cues", () => {
  const cues = parseSubtitleCues(
    [
      "WEBVTT",
      "",
      "NOTE source metadata",
      "this is not a cue",
      "",
      "valid-id",
      "00:00:01.250 --> 00:00:02.5 align:start",
      "A valid cue",
      "",
      "bad-id",
      "00:99:03.000 --> 00:99:04.000",
      "Invalid time",
      "",
      "next-id",
      "00:00:04.000 --> 00:00:03.000",
      "Reversed time",
    ].join("\n")
  )

  assert.deepEqual(cues, [
    { startTime: 1.25, endTime: 2.5, text: "A valid cue" },
  ])
})

void test("normalizes a BOM and CRLF line endings", () => {
  assert.deepEqual(
    parseSubtitleCues("\uFEFF1\r\n00:00:01,000 --> 00:00:02,000\r\nLine\r\n"),
    [{ startTime: 1, endTime: 2, text: "Line" }]
  )
})

void test("skips malformed blocks without discarding valid cues", () => {
  assert.deepEqual(
    parseSubtitleCues(
      "bad\nnot a timestamp\n\n1\n00:00:03,000 --> 00:00:04,000\nGood"
    ),
    [{ startTime: 3, endTime: 4, text: "Good" }]
  )
})

void test("derives a subtitle label and language from its filename", () => {
  assert.deepEqual(
    subtitleTrackName("https://media.example/movie.en.srt?token=private", 1),
    { label: "movie", language: "en" }
  )
  assert.deepEqual(subtitleTrackName("https://media.example/movie.vtt", 2), {
    label: "movie",
    language: "",
  })
  assert.deepEqual(subtitleTrackName("https://media.example/", 3), {
    label: "Subtitles 3",
    language: "",
  })
})

void test("strips common VTT markup and entities for canvas rendering", () => {
  assert.equal(
    subtitleCueDisplayText("<i>Hi</i>, &amp; &lt;there&gt; &quot;ok&quot;"),
    'Hi, & <there> "ok"'
  )
})

void test("retries a CORS-blocked subtitle through the media proxy", async () => {
  const originalFetch = globalThis.fetch
  const requests: string[] = []
  globalThis.fetch = async (input) => {
    requests.push(inputUrl(input))

    if (requests.length === 1) {
      throw new TypeError("CORS blocked")
    }

    return new Response("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi")
  }

  try {
    const result = await loadSubtitleCues(
      "https://media.example/subtitles.vtt?token=private",
      new AbortController().signal
    )

    assert.deepEqual(requests, [
      "https://media.example/subtitles.vtt?token=private",
      "/api/media-proxy?url=https%3A%2F%2Fmedia.example%2Fsubtitles.vtt%3Ftoken%3Dprivate",
    ])
    assert.deepEqual(result, {
      cues: [{ startTime: 1, endTime: 2, text: "Hi" }],
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

void test("preserves a readable throttling response without proxy retry", async () => {
  const originalFetch = globalThis.fetch
  const requests: string[] = []
  globalThis.fetch = async (input) => {
    requests.push(inputUrl(input))

    return new Response(null, {
      status: 429,
      headers: { "Retry-After": "60" },
    })
  }

  try {
    const result = await loadSubtitleCues(
      "https://media.example/subtitles.vtt",
      new AbortController().signal
    )

    assert.deepEqual(requests, ["https://media.example/subtitles.vtt"])
    assert.deepEqual(result, {
      failure: { kind: "http", status: 429, retryAfterMs: 60_000 },
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

void test("does not start a proxy fetch after cancellation", async () => {
  const originalFetch = globalThis.fetch
  const controller = new AbortController()
  const requests: string[] = []
  globalThis.fetch = async (input) => {
    requests.push(inputUrl(input))
    controller.abort()

    return new Response("blocked", { status: 403 })
  }

  try {
    const result = await loadSubtitleCues(
      "https://media.example/subtitles.vtt",
      controller.signal
    )

    assert.deepEqual(requests, ["https://media.example/subtitles.vtt"])
    assert.deepEqual(result, { aborted: true })
  } finally {
    globalThis.fetch = originalFetch
  }
})
