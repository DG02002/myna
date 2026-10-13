import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { PgsSubtitleOverlay } from "#/components/player/pgs-subtitle-overlay"
import { PgsSubtitleSession } from "#/media/pgs-subtitle-session"

interface TimeRequest {
  type: "time"
  generation: number
  sequence: number
  time: number
  redraw: boolean
}

interface TestBitmap {
  close(): void
  closed: boolean
}

type WorkerRequest =
  | { type: "init"; generation: number }
  | TimeRequest
  | { type: "release-frame"; generation: number; sequence: number }

type WorkerResponse =
  | { type: "ready"; generation: number }
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
      type: "hold"
      generation: number
      sequence: number
      requestSequence: number
    }

type WorkerListener = (event: MessageEvent<WorkerResponse>) => void

class HoldAwareWorker {
  readonly listeners = new Set<WorkerListener>()
  readonly timeRequests: TimeRequest[] = []
  readonly bitmaps: TestBitmap[] = []
  private readonly requestWaiters = new Map<
    number,
    (request: TimeRequest) => void
  >()
  private generation = 0
  private renderSequence = 0
  private lastVisualKey = ""

  addEventListener(type: string, listener: WorkerListener): void {
    if (type === "message") {
      this.listeners.add(listener)
    }
  }

  removeEventListener(type: string, listener: WorkerListener): void {
    if (type === "message") {
      this.listeners.delete(listener)
    }
  }

  terminate(): void {}

  postMessage(message: WorkerRequest): void {
    if (message.type === "init") {
      this.generation = message.generation
      queueMicrotask(() =>
        this.respond({ type: "ready", generation: this.generation })
      )

      return
    }

    if (message.type !== "time") {
      return
    }

    this.timeRequests.push(message)
    this.requestWaiters.get(this.timeRequests.length)?.(message)
    this.requestWaiters.delete(this.timeRequests.length)
  }

  waitForTimeRequest(index: number): Promise<TimeRequest> {
    const existing = this.timeRequests[index - 1]

    if (existing !== undefined) {
      return Promise.resolve(existing)
    }

    return new Promise((resolve) => {
      this.requestWaiters.set(index, resolve)
    })
  }

  respondToTimeRequest(index: number): "frame" | "hold" {
    const request = this.timeRequests[index - 1]

    if (request === undefined) {
      throw new Error(`No PGS time request ${index} was received.`)
    }

    if (request.redraw) {
      this.lastVisualKey = ""
    }

    const visualKey = keyForCue(request.time)

    if (visualKey === this.lastVisualKey) {
      this.respond({
        type: "hold",
        generation: request.generation,
        sequence: ++this.renderSequence,
        requestSequence: request.sequence,
      })

      return "hold"
    }

    this.lastVisualKey = visualKey
    const bitmap = createTestBitmap()
    this.bitmaps.push(bitmap)
    this.respond({
      type: "frame",
      generation: request.generation,
      sequence: ++this.renderSequence,
      requestSequence: request.sequence,
      bitmap,
      width: 1920,
      height: 1080,
    })

    return "frame"
  }

  private respond(data: WorkerResponse): void {
    const event = new MessageEvent<WorkerResponse>("message", { data })

    for (const listener of this.listeners) {
      listener(event)
    }
  }
}

interface SeekTestMedia {
  currentTime: number
  paused: boolean
  video: HTMLVideoElement
}

interface CanvasPixels {
  alphaPixelCount: number
}

interface BrowserMocks {
  getWorker: () => HoldAwareWorker
  restore: () => void
}

interface SeekHarness {
  container: HTMLDivElement
  media: SeekTestMedia
  pixels: CanvasPixels
  worker: HoldAwareWorker
}

describe.each([
  { playback: "paused", paused: true },
  { playback: "playing", paused: false },
])("PGS seek redraw while $playback", ({ paused }) => {
  let container: HTMLDivElement
  let root: Root
  let session: PgsSubtitleSession
  let media: SeekTestMedia
  let worker: HoldAwareWorker
  let pixels: CanvasPixels
  let restoreMocks: (() => void) | undefined
  let restoreCanvasContext: (() => void) | undefined

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

    const mocks = installBrowserMocks()
    restoreMocks = mocks.restore
    pixels = { alphaPixelCount: 0 }
    restoreCanvasContext = installCanvasContext(pixels)
    container = createTestContainer()
    root = createRoot(container)
    media = createTestMedia()
    session = new PgsSubtitleSession()
    worker = mocks.getWorker()
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    session.dispose()
    container.remove()
    restoreCanvasContext?.()
    restoreMocks?.()
  })

  it("redraws the destination composition after its in-seek frame was discarded", async () => {
    await mountOverlay(root, session, media.video)
    const initialRequest = await worker.waitForTimeRequest(1)
    setOverlaySize(container)
    await respondToTimeRequest(worker, 1, "frame")

    expect(initialRequest.time).toBe(86)
    expect(pixels.alphaPixelCount).toBe(16_606)

    const harness = { container, media, pixels, worker }
    const firstSeekRequest = await startPlaybackIfNeeded(paused, media, worker)

    const seekedRequest = await seekAndDiscardFrame(harness, firstSeekRequest)

    await completeSeek(harness, paused, seekedRequest)
  })
})

function createTestBitmap(): TestBitmap {
  return {
    closed: false,
    close() {
      this.closed = true
    },
  }
}

function keyForCue(time: number): string {
  return time >= 78 ? "subtitle-one:cue-78" : "subtitle-one:cue-17.809"
}

function installBrowserMocks(): BrowserMocks {
  const descriptors = new Map(
    ["Worker", "requestAnimationFrame", "cancelAnimationFrame"].map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ])
  )

  const workers: HoldAwareWorker[] = []

  class TestWorker extends HoldAwareWorker {
    constructor() {
      super()
      workers.push(this)
    }
  }

  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    value: TestWorker,
  })
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: () => 1,
  })
  Object.defineProperty(globalThis, "cancelAnimationFrame", {
    configurable: true,
    value: () => undefined,
  })

  return {
    getWorker() {
      const [worker] = workers

      if (worker === undefined) {
        throw new Error("The PGS session did not create a worker.")
      }

      return worker
    },
    restore() {
      for (const [name, descriptor] of descriptors) {
        restoreGlobalDescriptor(name, descriptor)
      }
    },
  }
}

function restoreGlobalDescriptor(
  name: string,
  descriptor: PropertyDescriptor | undefined
): void {
  if (descriptor === undefined) {
    Reflect.deleteProperty(globalThis, name)
  } else {
    Object.defineProperty(globalThis, name, descriptor)
  }
}

function installCanvasContext(pixels: CanvasPixels): () => void {
  // SAFETY: The overlay only calls clearRect and drawImage on this mock.
  const context = Object.create(null) as CanvasRenderingContext2D
  context.clearRect = () => {
    pixels.alphaPixelCount = 0
  }

  context.drawImage = () => {
    pixels.alphaPixelCount = 16_606
  }

  Object.defineProperty(context, "canvas", {
    value: document.createElement("canvas"),
  })

  const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext")
  getContext.mockReturnValue(context)

  return () => getContext.mockRestore()
}

function createTestContainer(): HTMLDivElement {
  const container = document.createElement("div")
  document.body.appendChild(container)

  return container
}

function createTestMedia(): SeekTestMedia {
  const media: SeekTestMedia = {
    currentTime: 86,
    paused: true,
    video: document.createElement("video"),
  }

  Object.defineProperties(media.video, {
    currentTime: { configurable: true, get: () => media.currentTime },
    paused: { configurable: true, get: () => media.paused },
  })

  return media
}

async function mountOverlay(
  root: Root,
  session: PgsSubtitleSession,
  video: HTMLVideoElement
): Promise<void> {
  await act(async () => {
    root.render(
      <PgsSubtitleOverlay
        session={session}
        trackId="pgs-track-3"
        useAdvancedEngine={false}
        nativeVideo={video}
        adapter={null}
        onFailure={() => undefined}
        onUnavailable={() => undefined}
      />
    )
    await Promise.resolve()
  })
}

function setOverlaySize(container: HTMLDivElement): void {
  const overlay = container.querySelector("[aria-hidden='true']")

  if (overlay === null) {
    throw new Error("The PGS overlay was not rendered.")
  }

  Object.defineProperties(overlay, {
    clientWidth: { configurable: true, value: 640 },
    clientHeight: { configurable: true, value: 360 },
  })
}

async function respondToTimeRequest(
  worker: HoldAwareWorker,
  index: number,
  expected: "frame" | "hold"
): Promise<void> {
  await act(async () => {
    expect(worker.respondToTimeRequest(index)).toBe(expected)
  })
}

async function startPlaybackIfNeeded(
  paused: boolean,
  media: SeekTestMedia,
  worker: HoldAwareWorker
): Promise<number> {
  if (paused) {
    return 2
  }

  await act(async () => {
    media.paused = false
    media.video.dispatchEvent(new Event("play"))
  })
  await worker.waitForTimeRequest(2)
  await respondToTimeRequest(worker, 2, "hold")

  return 3
}

async function seekAndDiscardFrame(
  { media, worker, pixels }: SeekHarness,
  requestIndex: number
): Promise<number> {
  await act(async () => {
    media.currentTime = 18.5
    media.video.dispatchEvent(new Event("seeking"))
    media.video.dispatchEvent(new Event("timeupdate"))
  })

  const inSeekRequest = await worker.waitForTimeRequest(requestIndex)
  expect(inSeekRequest.time).toBe(18.5)
  expect(inSeekRequest.redraw).toBe(true)
  expect(pixels.alphaPixelCount).toBe(0)
  await respondToTimeRequest(worker, requestIndex, "frame")
  expect(pixels.alphaPixelCount).toBe(0)
  expect(worker.bitmaps.at(-1)?.closed).toBe(true)

  return requestIndex + 1
}

async function completeSeek(
  { container, media, pixels, worker }: SeekHarness,
  paused: boolean,
  requestIndex: number
): Promise<void> {
  await act(async () => media.video.dispatchEvent(new Event("seeked")))

  const seekedRequest = await worker.waitForTimeRequest(requestIndex)
  expect(seekedRequest.time).toBe(18.5)
  expect(seekedRequest.redraw).toBe(true)
  await respondToTimeRequest(worker, requestIndex, "frame")

  const canvas = container.querySelector("canvas")
  expect(media.paused).toBe(paused)
  expect(pixels.alphaPixelCount).toBe(16_606)
  expect(canvas?.classList.contains("invisible")).toBe(false)
  expect(worker.bitmaps.at(-1)?.closed).toBe(true)
}
