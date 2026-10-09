import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"

import {
  createMatroskaSubtitleReader,
  type MatroskaPgsPacket,
} from "./matroska-subtitles"

type HarnessMessage =
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
      bitmap: { close(): void }
      width: number
      height: number
    }
  | {
      type: "clear"
      generation: number
      sequence: number
      requestSequence: number
    }
  | {
      type: "hold"
      generation: number
      sequence: number
      requestSequence: number
    }
  | {
      type: "unavailable"
      generation: number
      sequence: number
      requestSequence: number
    }
  | {
      type: "failed"
      generation: number
      sequence: number
      requestSequence: number
    }

type HarnessMessageOf<Type extends HarnessMessage["type"]> = Extract<
  HarnessMessage,
  { type: Type }
>

interface WorkerHarness {
  dispatch(message: HarnessMessage): void
  waitFor<T extends HarnessMessage>(
    predicate: (message: HarnessMessage) => message is T
  ): Promise<T>
  dispose(): void
}

function createWorkerHarness(): WorkerHarness {
  const originalSelfDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "self"
  )

  const listeners = new Set<(event: MessageEvent<HarnessMessage>) => void>()
  const messages: HarnessMessage[] = []
  const waiters = new Set<() => void>()

  const scope = {
    addEventListener: (
      type: string,
      listener: (event: MessageEvent<HarnessMessage>) => void
    ) => {
      if (type === "message") {
        listeners.add(listener)
      }
    },
    postMessage: (message: HarnessMessage) => {
      messages.push(message)

      for (const waiter of waiters) {
        waiter()
      }
    },
  }

  Object.defineProperty(globalThis, "self", {
    configurable: true,
    value: scope,
  })

  return {
    dispatch(message) {
      const event = new MessageEvent<HarnessMessage>("message", {
        data: message,
      })

      for (const listener of listeners) {
        listener(event)
      }
    },
    waitFor<T extends HarnessMessage>(
      predicate: (message: HarnessMessage) => message is T
    ): Promise<T> {
      const existing = messages.find(predicate)

      if (existing !== undefined) {
        return Promise.resolve(existing)
      }

      return new Promise((resolve) => {
        const waiter = () => {
          const match = messages.find(predicate)

          if (match === undefined) {
            return
          }

          waiters.delete(waiter)
          resolve(match)
        }

        waiters.add(waiter)
      })
    },
    dispose() {
      if (originalSelfDescriptor === undefined) {
        Reflect.deleteProperty(globalThis, "self")
      } else {
        Object.defineProperty(globalThis, "self", originalSelfDescriptor)
      }
    },
  }
}

async function readPgsFixture(): Promise<MatroskaPgsPacket[]> {
  const fixture = new Uint8Array(
    await readFile(
      new URL("../../tests/fixtures/pgs-acceptance.mkv", import.meta.url)
    )
  )

  const fetcher: typeof fetch = async (_input, init) => {
    const range = new Headers(init?.headers).get("range")
    const match = /^bytes=(\d+)-(\d+)$/.exec(range ?? "")

    if (match === null) {
      throw new Error("PGS fixture request did not use a byte range.")
    }

    const start = Number(match[1])
    const requestedEnd = Number(match[2])
    const end = Math.min(requestedEnd, fixture.byteLength - 1)

    return new Response(fixture.slice(start, end + 1), {
      status: 206,
      headers: {
        "Content-Range": `bytes ${start}-${end}/${fixture.byteLength}`,
        "Content-Length": String(end - start + 1),
      },
    })
  }

  const reader = createMatroskaSubtitleReader(
    "https://fixture.invalid/pgs-acceptance.mkv",
    fetcher
  )

  const controller = new AbortController()
  const tracks = await reader.probe(controller.signal)
  const track = tracks.find((candidate) => candidate.codecId === "S_HDMV/PGS")

  assert.ok(track)

  const packets: MatroskaPgsPacket[] = []

  for await (const packet of reader.streamPgsTrack(
    track.trackNumber,
    controller.signal
  )) {
    packets.push(packet)
  }

  return packets
}

async function sendPacket(
  harness: WorkerHarness,
  generation: number,
  sequence: number,
  packet: MatroskaPgsPacket
): Promise<void> {
  const acknowledgement = harness.waitFor(
    (message): message is HarnessMessageOf<"ack"> =>
      message.type === "ack" &&
      message.generation === generation &&
      message.sequence === sequence
  )

  harness.dispatch({
    type: "packet",
    generation,
    sequence,
    packet,
  })
  await acknowledgement
}

void test("uses incomplete finalization and reports actual worker render failures", async () => {
  const packets = await readPgsFixture()
  const originalFetch = globalThis.fetch

  const originalOffscreenCanvas = Object.getOwnPropertyDescriptor(
    globalThis,
    "OffscreenCanvas"
  )

  const wasmBytes = await readFile(
    new URL(
      "../../node_modules/libbitsub/pkg/libbitsub_bg.wasm",
      import.meta.url
    )
  )

  globalThis.fetch = async () => {
    return new Response(wasmBytes, {
      status: 200,
      headers: {
        "Content-Length": String(wasmBytes.byteLength),
        "Content-Type": "application/wasm",
      },
    })
  }

  class FailingOffscreenCanvas {
    constructor(
      readonly width: number,
      readonly height: number
    ) {}

    getContext(): null {
      return null
    }
  }

  Object.defineProperty(globalThis, "OffscreenCanvas", {
    configurable: true,
    value: FailingOffscreenCanvas,
  })

  const harness = createWorkerHarness()

  try {
    await import("./pgs-subtitle-worker")

    const firstGeneration = 101

    const firstReady = harness.waitFor(
      (message): message is HarnessMessageOf<"ready"> =>
        message.type === "ready" && message.generation === firstGeneration
    )

    harness.dispatch({ type: "init", generation: firstGeneration })
    await firstReady

    const [firstPacket] = packets
    assert.ok(firstPacket)
    await sendPacket(harness, firstGeneration, 1, firstPacket)

    const pendingClear = harness.waitFor(
      (message): message is HarnessMessageOf<"clear"> =>
        message.type === "clear" && message.generation === firstGeneration
    )

    harness.dispatch({
      type: "time",
      generation: firstGeneration,
      sequence: 2,
      time: 1,
      redraw: true,
    })
    await pendingClear
    harness.dispatch({
      type: "release-frame",
      generation: firstGeneration,
      sequence: 0,
    })

    const unavailable = harness.waitFor(
      (message): message is HarnessMessageOf<"unavailable"> =>
        message.type === "unavailable" && message.generation === firstGeneration
    )

    harness.dispatch({
      type: "finish",
      generation: firstGeneration,
      sequence: 3,
      coverageTime: 0,
      complete: true,
    })
    harness.dispatch({
      type: "time",
      generation: firstGeneration,
      sequence: 4,
      time: 1,
      redraw: true,
    })
    await unavailable

    const secondGeneration = 202

    const secondReady = harness.waitFor(
      (message): message is HarnessMessageOf<"ready"> =>
        message.type === "ready" && message.generation === secondGeneration
    )

    harness.dispatch({ type: "init", generation: secondGeneration })
    await secondReady

    for (const [index, packet] of packets.entries()) {
      await sendPacket(harness, secondGeneration, index + 1, packet)
    }

    const failed = harness.waitFor(
      (message): message is HarnessMessageOf<"failed"> =>
        message.type === "failed" && message.generation === secondGeneration
    )

    harness.dispatch({
      type: "finish",
      generation: secondGeneration,
      sequence: packets.length + 1,
      coverageTime: null,
      complete: true,
    })
    harness.dispatch({
      type: "time",
      generation: secondGeneration,
      sequence: packets.length + 2,
      time: 0,
      redraw: true,
    })

    const failure = await failed
    assert.equal(failure.requestSequence, packets.length + 2)
  } finally {
    harness.dispose()
    globalThis.fetch = originalFetch

    if (originalOffscreenCanvas === undefined) {
      Reflect.deleteProperty(globalThis, "OffscreenCanvas")
    } else {
      Object.defineProperty(
        globalThis,
        "OffscreenCanvas",
        originalOffscreenCanvas
      )
    }
  }
})
