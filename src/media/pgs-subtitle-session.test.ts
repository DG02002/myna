import assert from "node:assert/strict"
import { mock, test } from "node:test"

import {
  MatroskaSubtitleError,
  type MatroskaPgsPacket,
} from "./matroska-subtitles"
import { PgsSubtitleSession } from "./pgs-subtitle-session"
import { PGS_LIMITS } from "./pgs-subtitles"

interface TestBitmap {
  close(): void
}

type TestWorkerMessage =
  | { type: "init"; generation: number }
  | { type: "reset-window"; generation: number; sequence: number }
  | {
      type: "packet"
      generation: number
      sequence: number
      packet: MatroskaPgsPacket
    }
  | {
      type: "finish"
      generation: number
      sequence: number
      coverageTime: number | null
      complete: boolean
    }
  | {
      type: "time"
      generation: number
      sequence: number
      time: number
      redraw: boolean
    }
  | { type: "release-frame"; generation: number; sequence: number }
  | { type: "ready"; generation: number }
  | { type: "window-ready"; generation: number; sequence: number }
  | { type: "ack"; generation: number; sequence: number }
  | { type: "limit"; generation: number; sequence: number }
  | {
      type: "frame"
      generation: number
      sequence: number
      requestSequence: number
      bitmap: TestBitmap
      width: number
      height: number
    }
  | {
      type: "clear" | "hold" | "unavailable" | "failed"
      generation: number
      sequence: number
      requestSequence: number
    }

class PendingReadyWorker {
  readonly listeners = new Map<
    string,
    Set<(event: MessageEvent<TestWorkerMessage>) => void>
  >()

  readonly messages: TestWorkerMessage[] = []

  terminated = false

  addEventListener(
    type: string,
    listener: (event: MessageEvent<TestWorkerMessage>) => void
  ): void {
    const typeListeners = this.listeners.get(type) ?? new Set()
    typeListeners.add(listener)
    this.listeners.set(type, typeListeners)
  }

  removeEventListener(
    type: string,
    listener: (event: MessageEvent<TestWorkerMessage>) => void
  ): void {
    this.listeners.get(type)?.delete(listener)
  }

  postMessage(message: TestWorkerMessage): void {
    this.messages.push(message)
  }

  respond(data: TestWorkerMessage): void {
    const event = new MessageEvent<TestWorkerMessage>("message", { data })

    for (const listener of this.listeners.get("message") ?? []) {
      listener(event)
    }
  }

  terminate(): void {
    this.terminated = true
  }
}

function isMessageType<Type extends TestWorkerMessage["type"]>(
  message: TestWorkerMessage,
  type: Type
): message is Extract<TestWorkerMessage, { type: Type }> {
  return message.type === type
}

function lastMessageOfType<Type extends TestWorkerMessage["type"]>(
  worker: PendingReadyWorker,
  type: Type
): Extract<TestWorkerMessage, { type: Type }> {
  for (let index = worker.messages.length - 1; index >= 0; index -= 1) {
    const message = worker.messages[index]

    if (message !== undefined && isMessageType(message, type)) {
      return message
    }
  }

  return assert.fail(`Expected a ${type} worker message.`)
}

function getGeneration(worker: PendingReadyWorker): number {
  const message = worker.messages.find((candidate) =>
    isMessageType(candidate, "init")
  )

  assert.ok(message)

  return message.generation
}

interface AutoRespondingWorkerInstallation {
  restore: () => void
  workers: PendingReadyWorker[]
}

function waitForQueuedSignal(signals: (() => void)[]): Promise<void> {
  return new Promise((resolve) => {
    signals.push(resolve)
  })
}

function installAutoRespondingWorker(): AutoRespondingWorkerInstallation {
  const originalWorkerDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "Worker"
  )

  const workers: PendingReadyWorker[] = []

  class AutoRespondingWorker extends PendingReadyWorker {
    constructor() {
      super()
      workers.push(this)
    }

    override postMessage(message: TestWorkerMessage): void {
      // This in-memory Worker mock models Worker.postMessage, which has no origin argument.
      // oxlint-disable-next-line unicorn/require-post-message-target-origin
      super.postMessage(message)

      queueMicrotask(() => {
        const generation = getGeneration(this)

        if (message.type === "init") {
          this.respond({ type: "ready", generation })
        } else if (message.type === "reset-window") {
          this.respond({
            type: "window-ready",
            generation,
            sequence: message.sequence,
          })
        } else if (message.type === "packet") {
          this.respond({
            type: "ack",
            generation,
            sequence: message.sequence,
          })
        } else if (message.type === "time") {
          this.respond({
            type: "clear",
            generation,
            sequence: message.sequence,
            requestSequence: message.sequence,
          })
        }
      })
    }
  }

  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    value: AutoRespondingWorker,
  })

  return {
    workers,
    restore() {
      if (originalWorkerDescriptor === undefined) {
        Reflect.deleteProperty(globalThis, "Worker")
      } else {
        Object.defineProperty(globalThis, "Worker", originalWorkerDescriptor)
      }
    },
  }
}

interface PgsWindowInternals {
  activeWindowController: AbortController | null
  currentWindow: { start: number; end: number } | null
  failedWindowAttempts: number
  nextWindowRetryAt: number
  windowRetryExhausted: boolean
  attemptedPrefetchTarget: number | null
}

function accessWindowInternals(
  session: PgsSubtitleSession
): PgsWindowInternals {
  // SAFETY: This test view matches private fields declared by PgsSubtitleSession and stays within this unit-test helper.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- Runtime reflection would obscure this fixed test contract.
  return session as unknown as PgsWindowInternals
}

void test("disposal settles input while the worker is still initializing", async () => {
  const originalWorkerDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "Worker"
  )

  const workers: PendingReadyWorker[] = []

  class TestWorker extends PendingReadyWorker {
    constructor() {
      super()
      workers.push(this)
    }
  }

  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    value: TestWorker,
  })

  try {
    const session = new PgsSubtitleSession()

    const packet: MatroskaPgsPacket = {
      data: Uint8Array.of(0x80),
      startTime: 0,
      duration: null,
      location: { clusterPosition: 0, blockOffset: 0, segmentOffset: 0 },
    }

    const pendingPush = session.push(packet)
    const [worker] = workers

    assert.ok(worker)

    session.dispose()

    await assert.rejects(pendingPush, /Embedded PGS session was canceled/)
    assert.equal(worker.terminated, true)
    assert.equal(worker.listeners.get("message")?.size, 0)
    assert.equal(worker.listeners.get("error")?.size, 0)
  } finally {
    if (originalWorkerDescriptor === undefined) {
      Reflect.deleteProperty(globalThis, "Worker")
    } else {
      Object.defineProperty(globalThis, "Worker", originalWorkerDescriptor)
    }
  }
})

void test("resets the worker before feeding a target PGS window", async () => {
  const originalWorkerDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "Worker"
  )

  const workers: PendingReadyWorker[] = []
  let finishResolve!: () => void

  const finishSeen = new Promise<void>((resolve) => {
    finishResolve = resolve
  })

  class AutoRespondingWorker extends PendingReadyWorker {
    constructor() {
      super()
      workers.push(this)
    }

    override postMessage(message: TestWorkerMessage): void {
      // This in-memory Worker mock models Worker.postMessage, which has no origin argument.
      // oxlint-disable-next-line unicorn/require-post-message-target-origin
      super.postMessage(message)

      if (message.type === "finish") {
        finishResolve()
      }

      queueMicrotask(() => {
        const generation = getGeneration(this)

        if (message.type === "init") {
          this.respond({ type: "ready", generation })
        } else if (message.type === "reset-window") {
          this.respond({
            type: "window-ready",
            generation,
            sequence: message.sequence,
          })
        } else if (message.type === "packet") {
          this.respond({
            type: "ack",
            generation,
            sequence: message.sequence,
          })
        } else if (message.type === "time") {
          this.respond({
            type: "clear",
            generation,
            sequence: message.sequence,
            requestSequence: message.sequence,
          })
        }
      })
    }
  }

  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    value: AutoRespondingWorker,
  })

  try {
    const session = new PgsSubtitleSession()
    const [worker] = workers

    assert.ok(worker)

    session.setWindowLoader(async function* (targetTime) {
      yield { kind: "boundary", boundaryTime: targetTime }
      yield {
        kind: "packet",
        packet: {
          data: Uint8Array.of(0x80, 0, 0),
          startTime: targetTime,
          duration: null,
          location: {
            clusterPosition: 1,
            blockOffset: 2,
            segmentOffset: 0,
          },
        },
      }
      yield {
        kind: "coverage",
        coverageTime: targetTime + 20,
        complete: false,
      }
    })
    session.requestTime(5)

    await finishSeen

    const resetIndex = worker.messages.findIndex(
      (message) => message.type === "reset-window"
    )

    const packetIndex = worker.messages.findIndex(
      (message) => message.type === "packet"
    )

    const finishIndex = worker.messages.findIndex(
      (message) => message.type === "finish"
    )

    assert.ok(resetIndex >= 0)
    assert.ok(packetIndex > resetIndex)
    assert.ok(finishIndex > packetIndex)
    session.dispose()
  } finally {
    if (originalWorkerDescriptor === undefined) {
      Reflect.deleteProperty(globalThis, "Worker")
    } else {
      Object.defineProperty(globalThis, "Worker", originalWorkerDescriptor)
    }
  }
})

void test("cancels an in-flight PGS window when the seek target changes", () => {
  const originalWorkerDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "Worker"
  )

  const workers: PendingReadyWorker[] = []

  class TestWorker extends PendingReadyWorker {
    constructor() {
      super()
      workers.push(this)
    }
  }

  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    value: TestWorker,
  })

  try {
    const session = new PgsSubtitleSession()
    const signals: AbortSignal[] = []

    session.setWindowLoader((_, signal) => {
      signals.push(signal)

      return (async function* () {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true })
        })

        yield { kind: "coverage", coverageTime: 500, complete: false }
      })()
    })

    session.requestTime(100)
    session.requestTime(500)

    assert.equal(signals.length, 2)
    assert.equal(signals[0]?.aborted, true)
    assert.equal(signals[1]?.aborted, false)
    session.dispose()
    assert.equal(signals[1]?.aborted, true)
  } finally {
    if (originalWorkerDescriptor === undefined) {
      Reflect.deleteProperty(globalThis, "Worker")
    } else {
      Object.defineProperty(globalThis, "Worker", originalWorkerDescriptor)
    }
  }
})

void test("a new canvas subscriber receives the currently selected frame", async () => {
  const originalWorkerDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "Worker"
  )

  const workers: PendingReadyWorker[] = []

  class TestWorker extends PendingReadyWorker {
    constructor() {
      super()
      workers.push(this)
    }
  }

  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    value: TestWorker,
  })

  try {
    const session = new PgsSubtitleSession()
    const [worker] = workers

    assert.ok(worker)

    const generation = getGeneration(worker)
    const unsubscribeFirst = session.subscribe(() => undefined)

    worker.respond({ type: "ready", generation })
    session.requestTime(2)

    const firstTimeRequest = lastMessageOfType(worker, "time")

    assert.equal(firstTimeRequest.redraw, true)

    worker.respond({
      type: "hold",
      generation,
      sequence: firstTimeRequest.sequence,
      requestSequence: firstTimeRequest.sequence,
    })
    unsubscribeFirst()

    session.subscribe(() => undefined)

    const redrawRequest = lastMessageOfType(worker, "time")

    assert.equal(redrawRequest.type, "time")
    assert.equal(redrawRequest.redraw, true)

    session.dispose()
  } finally {
    if (originalWorkerDescriptor === undefined) {
      Reflect.deleteProperty(globalThis, "Worker")
    } else {
      Object.defineProperty(globalThis, "Worker", originalWorkerDescriptor)
    }
  }
})

void test("does not retry a failed PGS window on every playback time update", async () => {
  const originalWorkerDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "Worker"
  )

  class TestWorker extends PendingReadyWorker {}

  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    value: TestWorker,
  })

  try {
    const session = new PgsSubtitleSession()
    const attempts: number[] = []
    let unavailableResolve!: () => void

    const unavailable = new Promise<void>((resolve) => {
      unavailableResolve = resolve
    })

    session.subscribe((frame) => {
      if (frame.kind === "unavailable") {
        unavailableResolve()
      }
    })
    session.setWindowLoader(async function* (time) {
      attempts.push(time)

      yield { kind: "coverage", coverageTime: time, complete: false }
      throw new Error("simulated unavailable upstream")
    })

    session.requestTime(100)
    await unavailable

    for (const time of [100, 100.5, 101.01, 102.02, 103.03]) {
      session.requestTime(time)
      await new Promise<void>((resolve) => {
        setImmediate(() => resolve())
      })
    }

    assert.deepEqual(attempts, [100])
    session.dispose()
  } finally {
    if (originalWorkerDescriptor === undefined) {
      Reflect.deleteProperty(globalThis, "Worker")
    } else {
      Object.defineProperty(globalThis, "Worker", originalWorkerDescriptor)
    }
  }
})

void test("backs off PGS HTTP failures and allows an explicit retry", async () => {
  const originalWorkerDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "Worker"
  )

  class TestWorker extends PendingReadyWorker {}

  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    value: TestWorker,
  })

  try {
    let now = 0
    const session = new PgsSubtitleSession(() => now)
    const internals = accessWindowInternals(session)
    const attempts: number[] = []
    const failureWaiters: (() => void)[] = []

    session.subscribe((frame) => {
      if (frame.kind === "unavailable") {
        failureWaiters.shift()?.()
      }
    })
    session.setWindowLoader(async function* (time) {
      attempts.push(time)

      yield { kind: "coverage", coverageTime: time, complete: false }
      throw new MatroskaSubtitleError("http", undefined, {
        status: 429,
        retryAfterMs: 5_000,
      })
    })

    const firstFailure = waitForQueuedSignal(failureWaiters)
    session.requestTime(100)
    await firstFailure

    session.requestTime(101)
    await new Promise<void>((resolve) => {
      setImmediate(() => resolve())
    })
    assert.deepEqual(attempts, [100])

    now = 2_500
    session.retryWindow()
    await new Promise<void>((resolve) => {
      setImmediate(() => resolve())
    })
    assert.deepEqual(attempts, [100])
    assert.equal(internals.nextWindowRetryAt, 5_000)

    now = 4_999
    session.requestTime(102)
    await new Promise<void>((resolve) => {
      setImmediate(() => resolve())
    })
    assert.deepEqual(attempts, [100])

    now = 5_000
    const secondFailure = waitForQueuedSignal(failureWaiters)
    session.requestTime(103)
    await secondFailure
    assert.deepEqual(attempts, [100, 103])

    now = 10_000
    const thirdFailure = waitForQueuedSignal(failureWaiters)
    session.requestTime(104)
    await thirdFailure
    assert.deepEqual(attempts, [100, 103, 104])

    now = 20_000
    session.requestTime(105)
    await new Promise<void>((resolve) => {
      setImmediate(() => resolve())
    })
    assert.deepEqual(attempts, [100, 103, 104])

    const explicitRetryFailure = waitForQueuedSignal(failureWaiters)
    session.retryWindow()
    await explicitRetryFailure
    assert.deepEqual(attempts, [100, 103, 104, 105])
    session.dispose()
  } finally {
    if (originalWorkerDescriptor === undefined) {
      Reflect.deleteProperty(globalThis, "Worker")
    } else {
      Object.defineProperty(globalThis, "Worker", originalWorkerDescriptor)
    }
  }
})

void test("honors the latest Retry-After after automatic PGS retries are exhausted", async () => {
  const { restore } = installAutoRespondingWorker()

  try {
    let now = 0
    const session = new PgsSubtitleSession(() => now)
    const attempts: number[] = []
    const failureWaiters: (() => void)[] = []

    session.subscribe((frame) => {
      if (frame.kind === "unavailable") {
        failureWaiters.shift()?.()
      }
    })
    session.setWindowLoader((time) => {
      attempts.push(time)

      return (async function* () {
        yield { kind: "coverage", coverageTime: time, complete: false }
        throw new MatroskaSubtitleError("http", undefined, {
          status: 429,
          retryAfterMs: 60_000,
        })
      })()
    })

    const failWindowAt = async (time: number) => {
      const failed = waitForQueuedSignal(failureWaiters)
      session.requestTime(time)
      await failed
    }

    await failWindowAt(100)
    assert.deepEqual(attempts, [100])

    now = 60_000
    await failWindowAt(101)
    assert.deepEqual(attempts, [100, 101])

    now = 120_000
    await failWindowAt(102)
    assert.deepEqual(attempts, [100, 101, 102])

    session.retryWindow()
    session.requestTime(103)
    session.retryWindow()
    now = 179_999
    session.requestTime(104)
    session.retryWindow()
    assert.deepEqual(attempts, [100, 101, 102])

    now = 180_000
    session.requestTime(105)
    const permittedRetry = waitForQueuedSignal(failureWaiters)
    session.retryWindow()
    await permittedRetry
    assert.deepEqual(attempts, [100, 101, 102, 105])

    now = 239_999
    session.retryWindow()
    session.requestTime(106)
    assert.deepEqual(attempts, [100, 101, 102, 105])

    now = 240_000
    await failWindowAt(107)
    assert.deepEqual(attempts, [100, 101, 102, 105, 107])
    session.dispose()
  } finally {
    restore()
  }
})

void test("keeps exhausted Retry-After restrictions shared with retained-window prefetch", async () => {
  const { restore } = installAutoRespondingWorker()

  try {
    let now = 0
    let shouldFailPrefetch = false
    const failureClockWaiters: (() => void)[] = []
    let awaitingFailureClock = false
    let clearFrames = 0
    let activeWindowResolve!: () => void

    const activeWindow = new Promise<void>((resolve) => {
      activeWindowResolve = resolve
    })

    const session = new PgsSubtitleSession(() => {
      if (awaitingFailureClock) {
        awaitingFailureClock = false
        failureClockWaiters.shift()?.()
      }

      return now
    })

    const attempts: number[] = []

    session.subscribe((frame) => {
      if (frame.kind === "clear") {
        clearFrames += 1

        if (clearFrames === 2) {
          activeWindowResolve()
        }
      }
    })
    session.setWindowLoader((time) => {
      attempts.push(time)

      if (time === 150 || !shouldFailPrefetch) {
        return (async function* () {
          yield { kind: "boundary", boundaryTime: 100 }
          yield { kind: "coverage", coverageTime: 200, complete: false }
        })()
      }

      awaitingFailureClock = true

      return (async function* () {
        yield { kind: "coverage", coverageTime: 200, complete: false }
        throw new MatroskaSubtitleError("http", undefined, {
          status: 429,
          retryAfterMs: 60_000,
        })
      })()
    })

    session.requestTime(150)
    await activeWindow
    assert.deepEqual(attempts, [150])

    const nextPrefetchFailure = () => waitForQueuedSignal(failureClockWaiters)

    shouldFailPrefetch = true
    const firstFailure = nextPrefetchFailure()
    session.requestTime(171)
    await firstFailure
    assert.deepEqual(attempts, [150, 200])

    now = 60_000
    const secondFailure = nextPrefetchFailure()
    session.retryWindow()
    await secondFailure
    assert.deepEqual(attempts, [150, 200, 200])

    now = 120_000
    const thirdFailure = nextPrefetchFailure()
    session.retryWindow()
    await thirdFailure
    assert.deepEqual(attempts, [150, 200, 200, 200])

    session.retryWindow()
    session.requestTime(172)
    session.requestTime(201)
    now = 179_999
    session.retryWindow()
    session.requestTime(173)
    assert.deepEqual(attempts, [150, 200, 200, 200])

    now = 180_000
    const permittedRetry = nextPrefetchFailure()
    session.retryWindow()
    await permittedRetry
    assert.deepEqual(attempts, [150, 200, 200, 200, 200])

    now = 239_999
    session.retryWindow()
    session.requestTime(174)
    assert.deepEqual(attempts, [150, 200, 200, 200, 200])

    now = 240_000
    const nextPermittedRetry = nextPrefetchFailure()
    session.retryWindow()
    await nextPermittedRetry
    assert.deepEqual(attempts, [150, 200, 200, 200, 200, 200])
    session.dispose()
  } finally {
    restore()
  }
})

void test("applies Retry-After from PGS prefetch failures before active reads", async () => {
  const { restore } = installAutoRespondingWorker()

  try {
    let now = 0
    const session = new PgsSubtitleSession(() => now)
    const internals = accessWindowInternals(session)
    const attempts: number[] = []
    let prefetchStartedResolve!: () => void
    let prefetchFinishedResolve!: () => void
    let retryStartedResolve!: () => void

    const prefetchStarted = new Promise<void>((resolve) => {
      prefetchStartedResolve = resolve
    })

    const prefetchFinished = new Promise<void>((resolve) => {
      prefetchFinishedResolve = resolve
    })

    const retryStarted = new Promise<void>((resolve) => {
      retryStartedResolve = resolve
    })

    internals.currentWindow = { start: 100, end: 200 }

    session.setWindowLoader(async function* (time) {
      attempts.push(time)

      if (time === 200) {
        prefetchStartedResolve()

        try {
          throw new MatroskaSubtitleError("http", undefined, {
            status: 429,
            retryAfterMs: 60_000,
          })
        } finally {
          prefetchFinishedResolve()
        }
      }

      if (time === 203) {
        retryStartedResolve()
      }

      yield { kind: "boundary", boundaryTime: time }
      yield { kind: "coverage", coverageTime: time + 20, complete: false }
    })

    session.requestTime(170)
    await prefetchStarted
    await prefetchFinished
    await new Promise<void>((resolve) => {
      setImmediate(resolve)
    })

    assert.deepEqual(attempts, [200])
    assert.equal(internals.failedWindowAttempts, 1)
    assert.equal(internals.nextWindowRetryAt, 60_000)
    assert.equal(internals.windowRetryExhausted, false)
    assert.deepEqual(internals.currentWindow, { start: 100, end: 200 })

    session.requestTime(201)
    assert.equal(internals.activeWindowController, null)
    now = 59_999
    session.requestTime(202)
    assert.equal(internals.activeWindowController, null)
    assert.deepEqual(attempts, [200])

    now = 60_000
    session.requestTime(203)
    await retryStarted
    assert.deepEqual(attempts, [200, 203])
    session.dispose()
  } finally {
    restore()
  }
})

void test("an active PGS 429 blocks retained-coverage prefetch until eligible", async () => {
  const { restore } = installAutoRespondingWorker()

  try {
    let now = 0
    const session = new PgsSubtitleSession(() => now)
    const internals = accessWindowInternals(session)
    const attempts: number[] = []
    let activeFailureResolve!: () => void
    let eligiblePrefetchResolve!: () => void

    const activeFailure = new Promise<void>((resolve) => {
      activeFailureResolve = resolve
    })

    const eligiblePrefetch = new Promise<void>((resolve) => {
      eligiblePrefetchResolve = resolve
    })

    internals.currentWindow = { start: 100, end: 200 }

    session.subscribe((frame) => {
      if (frame.kind === "unavailable") {
        activeFailureResolve()
      }
    })

    session.setWindowLoader(async function* (time) {
      attempts.push(time)

      if (time === 300) {
        throw new MatroskaSubtitleError("http", undefined, {
          status: 429,
          retryAfterMs: 60_000,
        })
      }

      if (time === 200) {
        eligiblePrefetchResolve()
      }

      yield { kind: "boundary", boundaryTime: time }
      yield { kind: "coverage", coverageTime: time + 20, complete: false }
    })

    session.requestTime(300)
    await activeFailure

    assert.deepEqual(attempts, [300])
    assert.equal(internals.nextWindowRetryAt, 60_000)

    // Simulate repeated seeks and clock updates at changing playback rates.
    for (const time of [170, 171, 173, 176.5, 182, 190, 199]) {
      session.requestTime(time)
    }

    assert.deepEqual(attempts, [300])
    assert.equal(internals.attemptedPrefetchTarget, null)
    assert.deepEqual(internals.currentWindow, { start: 100, end: 200 })

    now = 60_000
    session.requestTime(170)
    await eligiblePrefetch

    assert.deepEqual(attempts, [300, 200])
    session.dispose()
  } finally {
    restore()
  }
})

void test("an active permanent PGS failure never starts a later prefetch", async () => {
  const { restore } = installAutoRespondingWorker()

  try {
    let now = 0
    const session = new PgsSubtitleSession(() => now)
    const internals = accessWindowInternals(session)
    const attempts: number[] = []
    let failedResolve!: () => void

    const failed = new Promise<void>((resolve) => {
      failedResolve = resolve
    })

    internals.currentWindow = { start: 100, end: 200 }
    session.subscribe((frame) => {
      if (frame.kind === "unavailable") {
        failedResolve()
      }
    })
    session.setWindowLoader(async function* (time) {
      attempts.push(time)

      if (time === 300) {
        throw new MatroskaSubtitleError("http", undefined, { status: 404 })
      }

      yield { kind: "boundary", boundaryTime: time }
      yield { kind: "coverage", coverageTime: time + 20, complete: false }
    })

    session.requestTime(300)
    await failed

    assert.equal(internals.windowRetryExhausted, true)
    now = 1_000_000

    for (const time of [170, 170.5, 175, 190, 199]) {
      session.requestTime(time)
    }

    assert.deepEqual(attempts, [300])
    assert.deepEqual(internals.currentWindow, { start: 100, end: 200 })
    session.dispose()
  } finally {
    restore()
  }
})

void test("canceling an active PGS read does not consume failure allowance", async () => {
  const { restore } = installAutoRespondingWorker()

  try {
    const session = new PgsSubtitleSession(() => 0)
    const internals = accessWindowInternals(session)
    let loadStartedResolve!: () => void
    let canceledResolve!: () => void

    const loadStarted = new Promise<void>((resolve) => {
      loadStartedResolve = resolve
    })

    const canceled = new Promise<void>((resolve) => {
      canceledResolve = resolve
    })

    session.setWindowLoader(async function* (_time, signal) {
      loadStartedResolve()

      await new Promise<never>((_resolve, reject) => {
        if (signal.aborted) {
          canceledResolve()
          reject(new Error("active read canceled"))

          return
        }

        signal.addEventListener(
          "abort",
          () => {
            canceledResolve()
            reject(new Error("active read canceled"))
          },
          { once: true }
        )
      })

      yield { kind: "boundary", boundaryTime: _time }
    })

    session.requestTime(300)
    await loadStarted
    session.dispose()
    await canceled
    await new Promise<void>((resolve) => {
      setImmediate(resolve)
    })

    assert.equal(internals.failedWindowAttempts, 0)
    assert.equal(internals.nextWindowRetryAt, 0)
    assert.equal(internals.windowRetryExhausted, false)
  } finally {
    restore()
  }
})

void test("exhausts automatic PGS prefetch retries for permanent failures", async () => {
  const { restore } = installAutoRespondingWorker()

  try {
    let now = 0
    const session = new PgsSubtitleSession(() => now)
    const internals = accessWindowInternals(session)
    const attempts: number[] = []
    let failedResolve!: () => void

    const failed = new Promise<void>((resolve) => {
      failedResolve = resolve
    })

    internals.currentWindow = { start: 100, end: 200 }

    session.setWindowLoader(async function* (time) {
      attempts.push(time)
      failedResolve()

      yield { kind: "boundary", boundaryTime: time }

      throw new MatroskaSubtitleError("http", undefined, {
        status: 404,
      })
    })

    session.requestTime(170)
    await failed
    await new Promise<void>((resolve) => {
      setImmediate(resolve)
    })

    assert.equal(internals.failedWindowAttempts, 1)
    assert.equal(internals.windowRetryExhausted, true)
    now = 1_000_000
    session.requestTime(201)
    assert.equal(internals.activeWindowController, null)
    assert.deepEqual(attempts, [200])
    assert.deepEqual(internals.currentWindow, { start: 100, end: 200 })
    session.dispose()
  } finally {
    restore()
  }
})

void test("does not count a canceled PGS prefetch as an upstream failure", async () => {
  const { restore } = installAutoRespondingWorker()

  try {
    const session = new PgsSubtitleSession(() => 0)
    const internals = accessWindowInternals(session)
    let prefetchStartedResolve!: () => void
    let canceledResolve!: () => void

    const prefetchStarted = new Promise<void>((resolve) => {
      prefetchStartedResolve = resolve
    })

    const canceled = new Promise<void>((resolve) => {
      canceledResolve = resolve
    })

    internals.currentWindow = { start: 100, end: 200 }

    // oxlint-disable-next-line require-yield -- This iterator only holds until cancellation and intentionally emits no window events.
    session.setWindowLoader(async function* (_time, signal) {
      prefetchStartedResolve()

      await new Promise<never>((_resolve, reject) => {
        if (signal.aborted) {
          canceledResolve()
          reject(new Error("prefetch canceled"))

          return
        }

        signal.addEventListener(
          "abort",
          () => {
            canceledResolve()
            reject(new Error("prefetch canceled"))
          },
          { once: true }
        )
      })
    })

    session.requestTime(170)
    await prefetchStarted
    session.dispose()
    await canceled
    await new Promise<void>((resolve) => {
      setImmediate(resolve)
    })

    assert.equal(internals.failedWindowAttempts, 0)
    assert.equal(internals.nextWindowRetryAt, 0)
    assert.equal(internals.windowRetryExhausted, false)
  } finally {
    restore()
  }
})

void test("drops a frame that completes after a seek invalidates it", () => {
  const originalWorkerDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "Worker"
  )

  const workers: PendingReadyWorker[] = []

  class TestWorker extends PendingReadyWorker {
    constructor() {
      super()
      workers.push(this)
    }
  }

  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    value: TestWorker,
  })

  try {
    const session = new PgsSubtitleSession()
    const [worker] = workers

    assert.ok(worker)

    const generation = getGeneration(worker)
    const frames: string[] = []
    session.subscribe((frame) => frames.push(frame.kind))
    worker.respond({ type: "ready", generation })
    session.requestTime(1)

    const firstTimeRequest = lastMessageOfType(worker, "time")

    session.requestTime(2)

    const normalBitmap = {
      close: () => undefined,
    }

    worker.respond({
      type: "frame",
      generation,
      sequence: 1,
      requestSequence: firstTimeRequest.sequence,
      bitmap: normalBitmap,
      width: 1,
      height: 1,
    })

    const normalPlaybackRequest = lastMessageOfType(worker, "time")

    assert.deepEqual(frames, ["frame"])
    assert.equal(normalPlaybackRequest.time, 2)

    worker.respond({
      type: "hold",
      generation,
      sequence: 2,
      requestSequence: normalPlaybackRequest.sequence,
    })

    session.requestTime(3)
    session.invalidatePendingRender()
    session.requestTime(5)

    let closed = false

    const bitmap = {
      close: () => {
        closed = true
      },
    }

    worker.respond({
      type: "frame",
      generation,
      sequence: 1,
      requestSequence: firstTimeRequest.sequence,
      bitmap,
      width: 1,
      height: 1,
    })

    const secondTimeRequest = lastMessageOfType(worker, "time")

    assert.deepEqual(frames, ["frame"])
    assert.equal(closed, true)
    assert.equal(secondTimeRequest.type, "time")
    assert.equal(secondTimeRequest.time, 5)
    assert.equal(secondTimeRequest.redraw, true)

    worker.respond({
      type: "hold",
      generation,
      sequence: 2,
      requestSequence: secondTimeRequest.sequence,
    })
    session.dispose()
  } finally {
    if (originalWorkerDescriptor === undefined) {
      Reflect.deleteProperty(globalThis, "Worker")
    } else {
      Object.defineProperty(globalThis, "Worker", originalWorkerDescriptor)
    }
  }
})

void test("rejects a packet when the worker stops responding", async () => {
  mock.timers.enable({ apis: ["setTimeout"] })

  const originalWorkerDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "Worker"
  )

  const workers: PendingReadyWorker[] = []

  class TestWorker extends PendingReadyWorker {
    constructor() {
      super()
      workers.push(this)
    }
  }

  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    value: TestWorker,
  })

  try {
    const session = new PgsSubtitleSession()
    const [worker] = workers

    assert.ok(worker)

    const generation = getGeneration(worker)
    worker.respond({ type: "ready", generation })

    const pendingPush = session.push({
      data: Uint8Array.of(0x80, 0, 0),
      startTime: 0,
      duration: null,
      location: { clusterPosition: 0, blockOffset: 0, segmentOffset: 0 },
    })

    await new Promise<void>((resolve) => {
      setImmediate(resolve)
    })
    mock.timers.tick(PGS_LIMITS.workerResponseTimeoutMs)
    await Promise.resolve()

    await assert.rejects(pendingPush, /Embedded PGS decoder worker timed out/)
    assert.equal(worker.terminated, true)
    const messageCount = worker.messages.length

    session.requestTime(1)

    assert.equal(worker.messages.length, messageCount)
  } finally {
    mock.timers.reset()

    if (originalWorkerDescriptor === undefined) {
      Reflect.deleteProperty(globalThis, "Worker")
    } else {
      Object.defineProperty(globalThis, "Worker", originalWorkerDescriptor)
    }
  }
})
