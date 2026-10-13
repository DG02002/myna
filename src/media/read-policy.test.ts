import assert from "node:assert/strict"
import { test } from "node:test"

import {
  Input,
  UrlSource,
  MP4,
  MATROSKA,
  WEBM,
  MP3,
  WAVE,
  OGG,
  ADTS,
  FLAC,
  MPEG_TS,
} from "mediabunny"

import { MediabunnyEngine } from "./engines/mediabunny-engine"
import { probeFileDetails, probeSource } from "./probe/metadata-probe"
import {
  AdvancedMediaReadError,
  AdvancedMediaReadPolicy,
  isProxyFallbackFailure,
} from "./read-policy"

const FILE_BYTES = Uint8Array.from([
  0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0, 0, 0, 0, 8,
  109, 111, 111, 118,
])

const MEDIA_URL = "https://media.example/file.mp4"

type TimerId = ReturnType<typeof setTimeout>

interface RequestState {
  signal?: AbortSignal
}

class FakeClock {
  private currentTime = 0
  private timerWaiters: (() => void)[] = []
  private readonly timers = new Map<
    TimerId,
    { at: number; callback: () => void }
  >()

  now = () => this.currentTime

  setTimeout = (callback: () => void, delayMs: number): TimerId => {
    const timerId = setTimeout(() => undefined, 60_000)

    timerId.unref?.()

    this.timers.set(timerId, {
      at: this.currentTime + delayMs,
      callback,
    })
    this.timerWaiters.shift()?.()

    return timerId
  }

  clearTimeout = (timer: TimerId): void => {
    this.timers.delete(timer)
    clearTimeout(timer)
  }

  get pendingTimerCount(): number {
    return this.timers.size
  }

  advance(delayMs: number): void {
    this.currentTime += delayMs

    for (;;) {
      const [next] = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= this.currentTime)
        .toSorted(
          ([, leftTimer], [, rightTimer]) => leftTimer.at - rightTimer.at
        )

      if (next === undefined) {
        return
      }

      const [timerId, timer] = next

      this.timers.delete(timerId)
      clearTimeout(timerId)
      timer.callback()
    }
  }

  waitForNextTimer(): Promise<void> {
    if (this.timers.size > 0) {
      return Promise.resolve()
    }

    return new Promise((resolve) => {
      this.timerWaiters.push(resolve)
    })
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void

  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })

  return { promise, resolve }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength)

  new Uint8Array(buffer).set(bytes)

  return buffer
}

function partialResponse(
  start: number,
  end: number,
  bytes: Uint8Array,
  total = FILE_BYTES.byteLength,
  declaredLength = bytes.byteLength,
  extraHeaders?: HeadersInit
): Response {
  return new Response(toArrayBuffer(bytes), {
    status: 206,
    headers: {
      "Content-Range": `bytes ${start}-${end}/${total}`,
      "Content-Length": String(declaredLength),
      ...Object.fromEntries(new Headers(extraHeaders).entries()),
    },
  })
}

function createInput(policy: AdvancedMediaReadPolicy): Input {
  return new Input({
    formats: [MP4, MATROSKA, WEBM, MP3, WAVE, OGG, ADTS, FLAC, MPEG_TS],
    source: new UrlSource(MEDIA_URL, {
      ...policy.urlSourceOptions,
      parallelism: 1,
    }),
  })
}

async function readResponseBody(response: Response): Promise<Uint8Array> {
  const reader = response.body?.getReader()

  assert.ok(reader)

  const chunks: Uint8Array[] = []

  for (;;) {
    const result = await reader.read()

    if (result.done) {
      break
    }

    chunks.push(result.value)
  }

  return new Uint8Array(Buffer.concat(chunks))
}

void test("Mediabunny UrlSource reads the small MP4 through the installed hooks", async () => {
  const policy = new AdvancedMediaReadPolicy({
    fetch: async (_input, init) => {
      const start = Number(
        /^bytes=(\d+)-/.exec(
          new Headers(init?.headers).get("Range") ?? ""
        )?.[1] ?? 0
      )

      return partialResponse(
        start,
        FILE_BYTES.byteLength - 1,
        FILE_BYTES.slice(start)
      )
    },
  })

  const input = createInput(policy)

  try {
    assert.equal((await input.getFormat()).name, "MP4")
    assert.deepEqual(await input.getTracks(), [])
    assert.equal(await input.getDurationFromMetadata(), null)
  } finally {
    input.dispose()
  }
})

void test("Mediabunny UrlSource retries a truncated response from the next byte", async () => {
  const ranges: string[] = []
  let requestCount = 0

  const policy = new AdvancedMediaReadPolicy({
    retryBaseDelayMs: 0,
    fetch: (_input, init) => {
      const range = new Headers(init?.headers).get("Range") ?? ""
      const start = Number(/^bytes=(\d+)-/.exec(range)?.[1] ?? 0)

      ranges.push(range)
      requestCount += 1

      return Promise.resolve(
        requestCount === 1
          ? partialResponse(
              0,
              FILE_BYTES.byteLength - 1,
              FILE_BYTES.slice(0, 8),
              FILE_BYTES.byteLength,
              FILE_BYTES.byteLength,
              { ETag: '"version-1"' }
            )
          : partialResponse(
              start,
              FILE_BYTES.byteLength - 1,
              FILE_BYTES.slice(start),
              FILE_BYTES.byteLength,
              undefined,
              { ETag: '"version-1"' }
            )
      )
    },
  })

  const input = createInput(policy)

  try {
    assert.equal((await input.getFormat()).name, "MP4")
    assert.deepEqual(ranges, ["bytes=0-", "bytes=8-"])
  } finally {
    input.dispose()
  }
})

void test("Mediabunny metadata read times out when response headers stall", async () => {
  const clock = new FakeClock()
  const requestStarted = deferred<AbortSignal>()

  const policy = new AdvancedMediaReadPolicy({
    clock,
    headerInactivityMs: 1_000,
    maxTransientRetries: 0,
    fetch: (_input, init) => {
      const signal = init?.signal

      if (signal === null || signal === undefined) {
        throw new Error("Mediabunny must pass a cancellation signal.")
      }

      requestStarted.resolve(signal)

      return new Promise<Response>(() => {})
    },
  })

  const input = createInput(policy)
  const format = input.getFormat()

  try {
    const requestSignal = await requestStarted.promise

    clock.advance(1_000)

    await assert.rejects(
      format,
      (error) =>
        error instanceof AdvancedMediaReadError && error.kind === "timeout"
    )
    assert.equal(requestSignal.aborted, true)
  } finally {
    input.dispose()
  }
})

void test("disposing a source aborts a pending header request immediately", async () => {
  const requestStarted = deferred<AbortSignal>()

  const policy = new AdvancedMediaReadPolicy({
    maxTransientRetries: 0,
    fetch: (_input, init) => {
      const signal = init?.signal

      if (signal === null || signal === undefined) {
        throw new Error("Mediabunny must pass a cancellation signal.")
      }

      requestStarted.resolve(signal)

      return new Promise<Response>(() => {})
    },
  })

  const input = createInput(policy)
  const format = input.getFormat()
  const requestSignal = await requestStarted.promise

  input.dispose()

  await assert.rejects(
    format,
    (error) => error instanceof Error && error.name === "InputDisposedError"
  )
  assert.equal(requestSignal.aborted, true)
})

void test("body inactivity deadline cancels the upstream response", async () => {
  const clock = new FakeClock()
  const bodyPullStarted = deferred<void>()
  const requestState: RequestState = {}

  const policy = new AdvancedMediaReadPolicy({
    clock,
    bodyInactivityMs: 1_000,
    fetch: (_input, init) => {
      requestState.signal = init?.signal ?? undefined

      const body = new ReadableStream<Uint8Array>({
        pull() {
          bodyPullStarted.resolve()
        },
      })

      return Promise.resolve(
        new Response(body, {
          status: 206,
          headers: {
            "Content-Range": `bytes 0-${FILE_BYTES.byteLength - 1}/${FILE_BYTES.byteLength}`,
            "Content-Length": String(FILE_BYTES.byteLength),
          },
        })
      )
    },
  })

  const response = await policy.fetchFn(MEDIA_URL, {
    headers: { Range: "bytes=0-" },
  })

  const reading = response.body?.getReader().read()

  assert.ok(reading)
  await bodyPullStarted.promise
  clock.advance(1_000)

  await assert.rejects(
    reading,
    (error) =>
      error instanceof AdvancedMediaReadError && error.kind === "timeout"
  )
  assert.equal(requestState.signal?.aborted, true)
})

void test("source cancellation closes a pending body read without an error", async () => {
  const bodyPullStarted = deferred<void>()
  const sourceController = new AbortController()
  let upstreamCanceled = false

  const policy = new AdvancedMediaReadPolicy({
    fetch: () => {
      const body = new ReadableStream<Uint8Array>({
        pull() {
          bodyPullStarted.resolve()
        },
        cancel() {
          upstreamCanceled = true
        },
      })

      return Promise.resolve(
        new Response(body, {
          status: 206,
          headers: {
            "Content-Range": `bytes 0-${FILE_BYTES.byteLength - 1}/${FILE_BYTES.byteLength}`,
            "Content-Length": String(FILE_BYTES.byteLength),
          },
        })
      )
    },
  })

  const response = await policy.fetchFn(MEDIA_URL, {
    headers: { Range: "bytes=0-" },
    signal: sourceController.signal,
  })

  const reader = response.body?.getReader()

  assert.ok(reader)
  const pendingRead = reader.read()

  await bodyPullStarted.promise
  sourceController.abort()

  assert.deepEqual(await pendingRead, { done: true, value: undefined })
  assert.equal(upstreamCanceled, true)
})

void test("body progress keeps a stream healthy beyond one inactivity window", async () => {
  const clock = new FakeClock()

  const bodySourceReady =
    deferred<ReadableStreamDefaultController<Uint8Array>>()

  const policy = new AdvancedMediaReadPolicy({
    clock,
    bodyInactivityMs: 15_000,
    fetch: () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          bodySourceReady.resolve(controller)
        },
        pull() {
          return new Promise<void>(() => {})
        },
      })

      return Promise.resolve(
        new Response(body, {
          status: 206,
          headers: {
            "Content-Range": "bytes 0-2/3",
            "Content-Length": "3",
          },
        })
      )
    },
  })

  const response = await policy.fetchFn(MEDIA_URL, {
    headers: { Range: "bytes=0-" },
  })

  const reader = response.body?.getReader()
  const bodyController = await bodySourceReady.promise

  assert.ok(reader)

  const received: number[] = []

  for (const byte of [1, 2, 3]) {
    const pendingChunk: Promise<ReadableStreamReadResult<Uint8Array>> =
      reader.read()

    clock.advance(14_000)
    bodyController.enqueue(Uint8Array.of(byte))

    const result: ReadableStreamReadResult<Uint8Array> = await pendingChunk

    assert.equal(result.done, false)
    received.push(result.value[0])
  }

  bodyController.close()

  assert.equal((await reader.read()).done, true)
  assert.deepEqual(received, [1, 2, 3])
  assert.ok(clock.now() > 15_000)
})

void test("truncated ranges resume from the delivered byte", async () => {
  let requestCount = 0
  const ranges: string[] = []

  const policy = new AdvancedMediaReadPolicy({
    maxTransientRetries: 2,
    retryBaseDelayMs: 0,
    fetch: (_input, init) => {
      const range = new Headers(init?.headers).get("Range") ?? ""

      ranges.push(range)
      requestCount += 1

      return requestCount === 1
        ? Promise.resolve(
            partialResponse(0, 3, Uint8Array.of(1, 2), 4, 4, {
              ETag: '"version-1"',
            })
          )
        : Promise.resolve(
            partialResponse(2, 3, Uint8Array.of(3, 4), 4, 2, {
              ETag: '"version-1"',
            })
          )
    },
  })

  const firstResponse = await policy.fetchFn(MEDIA_URL, {
    headers: { Range: "bytes=0-" },
  })

  const firstRead = firstResponse.body?.getReader()

  assert.ok(firstRead)
  assert.deepEqual((await firstRead.read()).value, Uint8Array.of(1, 2))
  await assert.rejects(firstRead.read(), (error) => {
    assert.ok(error instanceof AdvancedMediaReadError)
    assert.equal(error.kind, "truncated")
    assert.equal(policy.getRetryDelay(1, error, MEDIA_URL), 0)

    return true
  })

  const resumedResponse = await policy.fetchFn(MEDIA_URL, {
    headers: { Range: "bytes=2-" },
  })

  assert.deepEqual(await readResponseBody(resumedResponse), Uint8Array.of(3, 4))
  assert.deepEqual(ranges, ["bytes=0-", "bytes=2-"])
  assert.equal(requestCount, 2)
})

void test("does not continue a truncated response without a strong validator", async () => {
  let requestCount = 0

  const policy = new AdvancedMediaReadPolicy({
    retryBaseDelayMs: 0,
    fetch: () => {
      requestCount += 1

      return Promise.resolve(partialResponse(0, 3, Uint8Array.of(1, 2), 4, 4))
    },
  })

  const response = await policy.fetchFn(MEDIA_URL, {
    headers: { Range: "bytes=0-" },
  })

  const reader = response.body?.getReader()

  assert.ok(reader)
  await reader.read()
  await assert.rejects(reader.read(), (error) => {
    assert.ok(error instanceof AdvancedMediaReadError)
    assert.equal(error.kind, "truncated")
    assert.equal(policy.getRetryDelay(1, error, MEDIA_URL), null)

    return true
  })
  assert.equal(requestCount, 1)
})

void test("rejects a truncated continuation from a different resource version", async () => {
  let requestCount = 0

  const policy = new AdvancedMediaReadPolicy({
    retryBaseDelayMs: 0,
    fetch: () => {
      requestCount += 1

      return Promise.resolve(
        requestCount === 1
          ? partialResponse(0, 3, Uint8Array.of(1, 2), 4, 4, {
              ETag: '"version-1"',
            })
          : partialResponse(2, 3, Uint8Array.of(30, 40), 4, 2, {
              ETag: '"version-2"',
            })
      )
    },
  })

  const initial = await policy.fetchFn(MEDIA_URL, {
    headers: { Range: "bytes=0-" },
  })

  const reader = initial.body?.getReader()

  assert.ok(reader)
  await reader.read()
  await assert.rejects(reader.read(), (error) => {
    assert.ok(error instanceof AdvancedMediaReadError)
    assert.equal(error.kind, "truncated")
    assert.equal(policy.getRetryDelay(1, error, MEDIA_URL), 0)

    return true
  })

  await assert.rejects(
    policy.fetchFn(MEDIA_URL, { headers: { Range: "bytes=2-" } }),
    (error) => {
      assert.ok(error instanceof AdvancedMediaReadError)
      assert.equal(error.kind, "invalid-range")

      return true
    }
  )
  assert.equal(requestCount, 2)
})

void test("transient retry allowance carries across resumed byte offsets", async () => {
  let requestCount = 0

  const policy = new AdvancedMediaReadPolicy({
    maxTransientRetries: 1,
    retryBaseDelayMs: 0,
    fetch: (_input, init) => {
      requestCount += 1

      const start = Number(
        /^bytes=(\d+)-/.exec(
          new Headers(init?.headers).get("Range") ?? ""
        )?.[1] ?? 0
      )

      return Promise.resolve(
        partialResponse(start, 3, Uint8Array.of(1), 4, 4 - start, {
          ETag: '"version-1"',
        })
      )
    },
  })

  const firstAttempt = await policy.fetchFn(MEDIA_URL, {
    headers: { Range: "bytes=0-" },
  })

  const firstRead = firstAttempt.body?.getReader()

  assert.ok(firstRead)
  await firstRead.read()
  await assert.rejects(firstRead.read(), (error) => {
    assert.ok(error instanceof AdvancedMediaReadError)
    assert.equal(policy.getRetryDelay(1, error, MEDIA_URL), 0)

    return true
  })

  const resumedAttempt = await policy.fetchFn(MEDIA_URL, {
    headers: { Range: "bytes=1-" },
  })

  const resumedRead = resumedAttempt.body?.getReader()

  assert.ok(resumedRead)
  await resumedRead.read()
  await assert.rejects(resumedRead.read(), (error) => {
    assert.ok(error instanceof AdvancedMediaReadError)

    return policy.getRetryDelay(1, error, MEDIA_URL) === null
  })
  assert.equal(requestCount, 2)
})

void test("only cross-origin byte access failures qualify for proxy fallback", async () => {
  const blockedPolicy = new AdvancedMediaReadPolicy({
    pageOrigin: "https://app.example",
    fetch: () => Promise.reject(new TypeError("Failed to fetch")),
  })

  const readableFailurePolicy = new AdvancedMediaReadPolicy({
    pageOrigin: "https://app.example",
    retryBaseDelayMs: 0,
    fetch: () =>
      Promise.resolve(
        new Response(null, { status: 503, statusText: "unavailable" })
      ),
  })

  const invalidRangePolicy = new AdvancedMediaReadPolicy({
    pageOrigin: "https://app.example",
    fetch: () =>
      Promise.resolve(
        new Response(Uint8Array.of(1), {
          status: 206,
          headers: { "Content-Range": "bytes 1-1/2" },
        })
      ),
  })

  await assert.rejects(
    blockedPolicy.fetchFn(MEDIA_URL),
    (error) => error instanceof Error && isProxyFallbackFailure(error)
  )

  await assert.rejects(readableFailurePolicy.fetchFn(MEDIA_URL), (error) => {
    assert.ok(error instanceof AdvancedMediaReadError)
    assert.equal(error.status, 503)

    return !isProxyFallbackFailure(error)
  })

  await assert.rejects(
    invalidRangePolicy.fetchFn(MEDIA_URL, {
      headers: { Range: "bytes=0-" },
    }),
    (error) => {
      assert.ok(error instanceof AdvancedMediaReadError)
      assert.equal(error.kind, "invalid-range")

      return !isProxyFallbackFailure(error)
    }
  )
})

void test("retry delay honors Retry-After and is canceled before the next fetch", async () => {
  const clock = new FakeClock()
  const controller = new AbortController()
  let requestCount = 0

  const policy = new AdvancedMediaReadPolicy({
    clock,
    pageOrigin: "https://app.example",
    maxRetryAfterMs: 5_000,
    fetch: () => {
      requestCount += 1

      return Promise.resolve(
        new Response(null, {
          status: 429,
          headers: { "Retry-After": "2" },
        })
      )
    },
  })

  let retryError: unknown

  try {
    await policy.fetchFn(MEDIA_URL, { signal: controller.signal })
  } catch (error) {
    retryError = error
  }

  assert.ok(retryError instanceof AdvancedMediaReadError)
  assert.equal(retryError.retryAfterMs, 2_000)
  assert.equal(policy.getRetryDelay(1, retryError, MEDIA_URL), 0)

  const retryTimerScheduled = clock.waitForNextTimer()

  const nextFetch = policy.fetchFn(MEDIA_URL, {
    signal: controller.signal,
  })

  await retryTimerScheduled

  controller.abort()

  await assert.rejects(
    nextFetch,
    (error) =>
      error instanceof AdvancedMediaReadError && error.kind === "aborted"
  )
  assert.equal(requestCount, 1)
})

void test("read errors and diagnostics never retain the media URL", async () => {
  const diagnostics: unknown[] = []

  const policy = new AdvancedMediaReadPolicy({
    retryBaseDelayMs: 0,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    fetch: () =>
      Promise.resolve(
        new Response(null, { status: 404, statusText: "private reason" })
      ),
  })

  let failure: unknown

  try {
    await policy.fetchFn(`${MEDIA_URL}?token=secret`)
  } catch (error) {
    failure = error
  }

  assert.ok(failure instanceof AdvancedMediaReadError)
  assert.equal(failure.message.includes("secret"), false)
  assert.equal(JSON.stringify(diagnostics).includes("secret"), false)
  assert.equal(JSON.stringify(diagnostics).includes(MEDIA_URL), false)
})

void test("advanced read HTTP failures reach playback as network errors", async () => {
  const engine = new MediabunnyEngine(
    {
      source: { kind: "direct", url: MEDIA_URL },
      startTime: 0,
      autoPlay: false,
      volume: 1,
      muted: false,
      playbackRate: 1,
      audioTrackId: null,
    },
    {
      createInput: async () => {
        throw new AdvancedMediaReadError("http", 503)
      },
    }
  )

  let failure: { code: number; message: string } | null = null

  engine.listen((event) => {
    if (event.type === "error") {
      failure = { code: event.code, message: event.message }
    }
  })
  await engine.load()

  assert.deepEqual(failure, {
    code: 2,
    message: "Media server returned HTTP 503.",
  })
})

void test("status 200 that ignores Range remains a valid sequential response", async () => {
  const policy = new AdvancedMediaReadPolicy({
    fetch: () =>
      Promise.resolve(
        new Response(FILE_BYTES, {
          status: 200,
          headers: { "Content-Length": String(FILE_BYTES.byteLength) },
        })
      ),
  })

  const response = await policy.fetchFn(MEDIA_URL, {
    headers: { Range: "bytes=0-" },
  })

  assert.equal(response.status, 200)
  assert.deepEqual(await readResponseBody(response), FILE_BYTES)
})

void test("metadata probe retries readable 503 responses without proxy fallback", async () => {
  let requestCount = 0

  const readPolicy = new AdvancedMediaReadPolicy({
    pageOrigin: "https://app.example",
    maxTransientRetries: 2,
    retryBaseDelayMs: 0,
    fetch: () => {
      requestCount += 1

      return Promise.resolve(new Response(null, { status: 503 }))
    },
  })

  await assert.rejects(
    probeSource(
      { kind: "direct", url: MEDIA_URL },
      new AbortController().signal,
      { readPolicy }
    ),
    (error) => !(error instanceof Error && isProxyFallbackFailure(error))
  )
  assert.equal(requestCount, 3)
})

void test("metadata probe preserves Retry-After and does not proxy readable 429", async () => {
  let requestCount = 0

  const readPolicy = new AdvancedMediaReadPolicy({
    pageOrigin: "https://app.example",
    maxRetryAfterMs: 30_000,
    fetch: () => {
      requestCount += 1

      return Promise.resolve(
        new Response(null, {
          status: 429,
          headers: { "Retry-After": "60" },
        })
      )
    },
  })

  await assert.rejects(
    probeSource(
      { kind: "direct", url: MEDIA_URL },
      new AbortController().signal,
      { readPolicy }
    ),
    (error) => {
      assert.ok(error instanceof AdvancedMediaReadError)
      assert.equal(error.status, 429)
      assert.equal(error.retryAfterMs, 60_000)

      return !isProxyFallbackFailure(error)
    }
  )
  assert.equal(requestCount, 1)
})

void test("repeated rejected fetches stop after the finite retry allowance", async () => {
  let requestCount = 0

  const readPolicy = new AdvancedMediaReadPolicy({
    pageOrigin: "https://media.example",
    maxTransientRetries: 2,
    retryBaseDelayMs: 0,
    fetch: () => {
      requestCount += 1

      return Promise.reject(new TypeError("Network request failed"))
    },
  })

  await assert.rejects(
    probeSource(
      { kind: "direct", url: MEDIA_URL },
      new AbortController().signal,
      { readPolicy }
    ),
    (error) => {
      assert.ok(error instanceof AdvancedMediaReadError)
      assert.equal(error.kind, "network")

      return !isProxyFallbackFailure(error)
    }
  )
  assert.equal(requestCount, 3)
})

void test("metadata probe uses the proxy only after cross-origin byte access fails", async () => {
  const requests: string[] = []

  const readPolicy = new AdvancedMediaReadPolicy({
    pageOrigin: "https://app.example",
    fetch: (input, init) => {
      const url = new URL(
        input instanceof Request ? input.url : String(input),
        "https://app.example"
      )

      requests.push(url.origin)

      if (url.origin !== "https://app.example") {
        return Promise.reject(new TypeError("Failed to fetch"))
      }

      const start = Number(
        /^bytes=(\d+)-/.exec(
          new Headers(init?.headers).get("Range") ?? ""
        )?.[1] ?? 0
      )

      return Promise.resolve(
        partialResponse(
          start,
          FILE_BYTES.byteLength - 1,
          FILE_BYTES.slice(start)
        )
      )
    },
  })

  const result = await probeSource(
    { kind: "direct", url: MEDIA_URL },
    new AbortController().signal,
    { readPolicy }
  )

  assert.equal(result.readMode, "proxy")
  assert.deepEqual(requests, ["https://media.example", "https://app.example"])
})

void test("file details do not proxy a readable HTTP failure", async () => {
  let requestCount = 0

  const readPolicy = new AdvancedMediaReadPolicy({
    pageOrigin: "https://app.example",
    fetch: () => {
      requestCount += 1

      return Promise.resolve(new Response(null, { status: 404 }))
    },
  })

  assert.equal(
    await probeFileDetails(
      { kind: "direct", url: MEDIA_URL },
      new AbortController().signal,
      readPolicy
    ),
    null
  )
  assert.equal(requestCount, 1)
})

void test("file details retry readable transient HTTP failures without proxying", async () => {
  const requestOrigins: string[] = []
  const diagnostics: { event: string; status: number | null }[] = []
  let requestCount = 0

  const readPolicy = new AdvancedMediaReadPolicy({
    pageOrigin: "https://app.example",
    retryBaseDelayMs: 0,
    onDiagnostic: ({ event, status }) => diagnostics.push({ event, status }),
    fetch: (input) => {
      const url = new URL(
        input instanceof Request ? input.url : String(input),
        "https://app.example"
      )

      requestOrigins.push(url.origin)
      requestCount += 1

      if (requestCount === 1) {
        return Promise.resolve(
          new Response(null, {
            status: 503,
            headers: { "Retry-After": "0" },
          })
        )
      }

      return Promise.resolve(
        partialResponse(0, 0, Uint8Array.of(0), FILE_BYTES.byteLength)
      )
    },
  })

  const details = await probeFileDetails(
    { kind: "direct", url: MEDIA_URL },
    new AbortController().signal,
    readPolicy
  )

  assert.deepEqual(details, {
    filename: "file.mp4",
    sizeBytes: FILE_BYTES.byteLength,
  })
  assert.equal(requestCount, 2)
  assert.deepEqual(requestOrigins, [
    "https://media.example",
    "https://media.example",
  ])
  assert.deepEqual(diagnostics, [{ event: "retry", status: 503 }])
})

void test("file details cancel a scheduled retry when the source changes", async () => {
  const clock = new FakeClock()
  const retryScheduled = deferred<void>()
  const controller = new AbortController()
  let requestCount = 0

  const readPolicy = new AdvancedMediaReadPolicy({
    clock,
    pageOrigin: "https://app.example",
    onDiagnostic: ({ event }) => {
      if (event === "retry") {
        retryScheduled.resolve()
      }
    },
    fetch: () => {
      requestCount += 1

      return Promise.resolve(
        new Response(null, {
          status: 429,
          headers: { "Retry-After": "2" },
        })
      )
    },
  })

  const details = probeFileDetails(
    { kind: "direct", url: MEDIA_URL },
    controller.signal,
    readPolicy
  )

  await retryScheduled.promise
  await clock.waitForNextTimer()
  controller.abort()

  assert.equal(await details, null)
  assert.equal(requestCount, 1)
  assert.equal(clock.pendingTimerCount, 0)
})

void test("file details use a same-origin proxy after cross-origin byte access fails", async () => {
  const requests: string[] = []

  const readPolicy = new AdvancedMediaReadPolicy({
    pageOrigin: "https://app.example",
    fetch: (input) => {
      const url = new URL(
        input instanceof Request ? input.url : String(input),
        "https://app.example"
      )

      requests.push(url.origin)

      if (url.origin !== "https://app.example") {
        return Promise.reject(new TypeError("Failed to fetch"))
      }

      return Promise.resolve(
        partialResponse(0, 0, Uint8Array.of(1), FILE_BYTES.byteLength)
      )
    },
  })

  const details = await probeFileDetails(
    { kind: "direct", url: MEDIA_URL },
    new AbortController().signal,
    readPolicy
  )

  assert.deepEqual(details, {
    filename: "file.mp4",
    sizeBytes: FILE_BYTES.byteLength,
  })
  assert.deepEqual(requests, ["https://media.example", "https://app.example"])
})
