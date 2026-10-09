import assert from "node:assert/strict"
import { mock, test } from "node:test"

import type { MatroskaPgsPacket } from "./matroska-subtitles"
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
