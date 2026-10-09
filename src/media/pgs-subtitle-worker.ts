/// <reference lib="webworker" />

import wasmInit, { PgsParser } from "libbitsub/pkg"

import type { MatroskaPgsPacket } from "./matroska-subtitles"
import {
  compositePgsFrame,
  createPgsSupSegment,
  PGS_LIMITS,
  PgsDisplaySetInspector,
  type PgsDisplaySet,
  type PgsComposition,
  type PgsRgbaComposition,
} from "./pgs-subtitles"

type Request =
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

type WorkerResponse =
  | { type: "ready"; generation: number }
  | { type: "window-ready"; generation: number; sequence: number }
  | { type: "ack" | "limit"; generation: number; sequence: number }
  | {
      type: "frame"
      generation: number
      sequence: number
      requestSequence: number
      bitmap: ImageBitmap
      width: number
      height: number
    }
  | {
      type: "clear" | "hold" | "unavailable" | "failed"
      generation: number
      sequence: number
      requestSequence: number
    }

interface TimelineEvent {
  time: number
  kind: "composition" | "clear" | "invalid"
  parserIndex: number
  duration: number | null
  boundaryIndex: number
  composition: PgsComposition | null
}

// SAFETY: PgsSubtitleSession creates this module only with the DedicatedWorker constructor.
const worker = self as DedicatedWorkerGlobalScope

let generation = -1

let parser: PgsParser | null = null

let inspector: PgsDisplaySetInspector | null = null

let baseTime: number | null = null

let compressedBytes = 0

let decoderReplayBytes = 0

let packetCount = 0

let coverageTime = Number.NEGATIVE_INFINITY

let complete = false

let extractionFinished = false

let failure = false

let requestedTime: number | null = null

let requestedRequestSequence = 0

let rendering = false

let awaitingRelease = false

let lastVisualKey = ""

let renderSequence = 0

let latestBoundaryIndex = 0

let timelineReferences = 0

const timeline: TimelineEvent[] = []

let pendingWindowReset: Extract<Request, { type: "reset-window" }> | null = null

worker.addEventListener("message", (event: MessageEvent<Request>) => {
  void handleRequest(event.data)
})

function postToMainThread(
  message: WorkerResponse,
  transfer: Transferable[] = []
): void {
  worker.postMessage(message, transfer)
}

async function handleRequest(request: Request): Promise<void> {
  if (request.type === "init") {
    await initialize(request.generation)

    return
  }

  if (request.generation !== generation) {
    return
  }

  switch (request.type) {
    case "release-frame":
      awaitingRelease = false

      if (pendingWindowReset !== null) {
        const reset = pendingWindowReset
        pendingWindowReset = null
        resetWindow(reset)

        return
      }

      await renderRequestedTime()

      return
    case "reset-window":
      if (rendering || awaitingRelease) {
        pendingWindowReset = request
      } else {
        resetWindow(request)
      }

      return
    case "time":
      if (request.redraw) {
        lastVisualKey = ""
      }

      requestedTime = request.time
      requestedRequestSequence = request.sequence
      await renderRequestedTime()

      return
    case "finish":
      applyFinish(request)

      return
    case "packet":
      handlePacket(request)

      return
  }
}

async function initialize(nextGeneration: number): Promise<void> {
  generation = nextGeneration
  resetWorkerState()

  try {
    await initializeWasm()
    parser = new PgsParser()
    inspector = new PgsDisplaySetInspector()
    postToMainThread({ type: "ready", generation })
  } catch {
    failure = true
    postState("failed", 0)
  }
}

function resetWindow(
  request: Extract<Request, { type: "reset-window" }>
): void {
  resetWorkerState()

  try {
    parser = new PgsParser()
    inspector = new PgsDisplaySetInspector()
    postToMainThread({
      type: "window-ready",
      generation,
      sequence: request.sequence,
    })
  } catch {
    failure = true
    postState("failed", request.sequence)
  }
}

function resetWorkerState(): void {
  pendingWindowReset = null
  parser = null
  inspector = null
  baseTime = null
  compressedBytes = 0
  decoderReplayBytes = 0
  packetCount = 0
  coverageTime = Number.NEGATIVE_INFINITY
  complete = false
  extractionFinished = false
  failure = false
  requestedTime = null
  requestedRequestSequence = 0
  rendering = false
  awaitingRelease = false
  lastVisualKey = ""
  renderSequence = 0
  latestBoundaryIndex = 0
  timelineReferences = 0
  timeline.length = 0
}

async function initializeWasm(): Promise<void> {
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | null = null

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort()
      reject(new Error("Embedded PGS decoder WASM timed out."))
    }, PGS_LIMITS.wasmInitTimeoutMs)
  })

  const originalFetch = globalThis.fetch.bind(globalThis)

  const boundedFetch: typeof fetch = async (input, init) => {
    const response = await originalFetch(input, {
      ...init,
      signal: controller.signal,
    })

    return readBoundedWasmResponse(response)
  }

  globalThis.fetch = boundedFetch

  try {
    await Promise.race([wasmInit(), timeoutPromise])
  } finally {
    globalThis.fetch = originalFetch

    if (timeout !== null) {
      clearTimeout(timeout)
    }
  }
}

async function readBoundedWasmResponse(
  response: globalThis.Response
): Promise<globalThis.Response> {
  if (!response.ok) {
    throw new Error("Embedded PGS decoder WASM could not be loaded.")
  }

  const contentLength = Number(response.headers.get("content-length"))

  if (
    Number.isFinite(contentLength) &&
    contentLength > PGS_LIMITS.maxWasmBytes
  ) {
    throw new Error("Embedded PGS decoder WASM exceeds its byte limit.")
  }

  if (response.body === null) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    assertWasmByteLimit(bytes.byteLength)

    return createWasmResponse(response, bytes)
  }

  const bytes = await readBoundedWasmBody(response.body)

  return createWasmResponse(response, bytes)
}

async function readBoundedWasmBody(
  body: ReadableStream<Uint8Array>
): Promise<Uint8Array> {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0

  try {
    while (true) {
      // oxlint-disable-next-line no-await-in-loop -- The bounded stream must be read in order.
      const { done, value } = await reader.read()

      if (done) {
        break
      }

      totalBytes += value.byteLength

      if (totalBytes > PGS_LIMITS.maxWasmBytes) {
        // oxlint-disable-next-line no-await-in-loop -- Release the bounded reader before failing.
        await reader.cancel()
        assertWasmByteLimit(totalBytes)
      }

      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(totalBytes)
  let offset = 0

  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }

  return bytes
}

function assertWasmByteLimit(byteLength: number): void {
  if (byteLength > PGS_LIMITS.maxWasmBytes) {
    throw new Error("Embedded PGS decoder WASM exceeds its byte limit.")
  }
}

function createWasmResponse(
  response: globalThis.Response,
  bytes: Uint8Array
): globalThis.Response {
  const body = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(body).set(bytes)

  return new globalThis.Response(body, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  })
}

function applyFinish(request: Extract<Request, { type: "finish" }>): void {
  const { complete: isComplete, coverageTime: requestedCoverageTime } = request
  const incompleteDisplaySetTime = inspector?.finish() ?? null
  extractionFinished = true
  complete = isComplete && incompleteDisplaySetTime === null

  if (complete) {
    coverageTime = Number.POSITIVE_INFINITY

    return
  }

  coverageTime = requestedCoverageTime ?? coverageTime
  addInvalidBoundary(incompleteDisplaySetTime)
  addInvalidBoundary(coverageTime)
}

function handlePacket(request: Extract<Request, { type: "packet" }>): void {
  try {
    addPacket(request.packet)
    coverageTime = Math.max(coverageTime, request.packet.startTime)
    postToMainThread({
      type: "ack",
      generation,
      sequence: request.sequence,
    })
  } catch {
    inspector?.discardPending()
    addInvalidBoundary(request.packet.startTime)
    coverageTime = request.packet.startTime
    postToMainThread({
      type: "limit",
      generation,
      sequence: request.sequence,
    })
  }
}

function addPacket(packet: MatroskaPgsPacket): void {
  const currentParser = requireParser()
  const currentInspector = requireInspector()
  registerPacket(packet)

  let displaySet: PgsDisplaySet | null

  try {
    displaySet = currentInspector.push(packet)
  } catch (error) {
    currentInspector.discardPending()
    throw error
  }

  if (displaySet === null) {
    return
  }

  if (!displaySet.valid) {
    recordInvalidDisplaySet(displaySet)

    return
  }

  const parserIndex = feedDisplaySet(
    displaySet,
    currentParser,
    currentInspector
  )

  if (parserIndex !== null) {
    recordDisplaySet(displaySet, parserIndex)
  }
}

function registerPacket(packet: MatroskaPgsPacket): void {
  if (
    packet.data.byteLength > PGS_LIMITS.maxPacketBytes ||
    packetCount >= PGS_LIMITS.maxPackets ||
    compressedBytes > PGS_LIMITS.maxReplayBytes - packet.data.byteLength
  ) {
    throw new Error("PGS replay limit exceeded.")
  }

  packetCount += 1
  compressedBytes += packet.data.byteLength
  baseTime ??= packet.startTime

  if (packet.startTime - baseTime > PGS_LIMITS.maxTimestampSpan) {
    throw new Error("PGS timestamp exceeds the decoder's 32-bit range.")
  }
}

function requireParser(): PgsParser {
  if (parser === null) {
    throw new Error("PGS parser is not initialized.")
  }

  return parser
}

function requireInspector(): PgsDisplaySetInspector {
  if (inspector === null) {
    throw new Error("PGS state inspector is not initialized.")
  }

  return inspector
}

function recordInvalidDisplaySet(displaySet: PgsDisplaySet): void {
  timeline.push({
    time: displaySet.timestamp,
    kind: "invalid",
    parserIndex: -1,
    duration: null,
    boundaryIndex: latestBoundaryIndex,
    composition: null,
  })
}

function feedDisplaySet(
  displaySet: PgsDisplaySet,
  currentParser: PgsParser,
  currentInspector: PgsDisplaySetInspector
): number | null {
  if (
    displaySet.decoderBytes >
    PGS_LIMITS.maxReplayBytes - decoderReplayBytes
  ) {
    throw new Error("PGS decoder replay limit exceeded.")
  }

  decoderReplayBytes += displaySet.decoderBytes
  const bytes = createDisplaySetBytes(displaySet)
  const previousCount = currentParser.count
  const added = currentParser.feed(bytes)

  if (added !== 1 || currentParser.count !== previousCount + 1) {
    currentInspector.invalidateState()
    recordInvalidDisplaySet(displaySet)

    return null
  }

  return currentParser.count - 1
}

function createDisplaySetBytes(displaySet: PgsDisplaySet): Uint8Array {
  const timestampOrigin = baseTime

  if (timestampOrigin === null) {
    throw new Error("PGS timestamp origin is missing.")
  }

  const displaySetBytes = displaySet.segments.reduce(
    (total, segment) => total + segment.data.byteLength + 10,
    0
  )

  if (displaySetBytes > PGS_LIMITS.maxDisplaySetBytes) {
    throw new Error("PGS display set exceeds its input limit.")
  }

  const wrappedSegments = displaySet.segments.map((segment) =>
    createPgsSupSegment(segment, timestampOrigin)
  )

  const bytes = new Uint8Array(displaySetBytes)
  let offset = 0

  for (const segment of wrappedSegments) {
    bytes.set(segment, offset)
    offset += segment.byteLength
  }

  return bytes
}

function recordDisplaySet(
  displaySet: PgsDisplaySet,
  parserIndex: number
): void {
  if (displaySet.boundary) {
    latestBoundaryIndex = parserIndex
  }

  const { composition } = displaySet

  if (composition === null) {
    return
  }

  timelineReferences += composition.objects.length

  if (timelineReferences > PGS_LIMITS.maxTimelineReferences) {
    throw new Error("PGS composition replay metadata exceeds its limit.")
  }

  timeline.push({
    time: displaySet.timestamp,
    kind: composition.clear ? "clear" : "composition",
    parserIndex,
    duration: composition.duration,
    boundaryIndex: latestBoundaryIndex,
    composition,
  })
}

function addInvalidBoundary(time: number | null): void {
  if (time === null || !Number.isFinite(time)) {
    return
  }

  timeline.push({
    time,
    kind: "invalid",
    parserIndex: -1,
    duration: null,
    boundaryIndex: latestBoundaryIndex,
    composition: null,
  })
}

async function renderRequestedTime(): Promise<void> {
  if (rendering || awaitingRelease || requestedTime === null) {
    return
  }

  rendering = true
  const time = requestedTime
  const requestSequence = requestedRequestSequence
  requestedTime = null

  try {
    await renderTime(time, requestSequence)
  } catch {
    failure = true
    await postFailedIfChanged(requestSequence)
  } finally {
    rendering = false
  }

  if (requestedTime !== null) {
    await renderRequestedTime()
  }
}

async function renderTime(
  time: number,
  requestSequence: number
): Promise<void> {
  if (failure) {
    await postFailedIfChanged(requestSequence)

    return
  }

  if (parser === null) {
    await postUnavailableIfChanged("decoder", requestSequence)

    return
  }

  if (time > coverageTime && !complete) {
    if (extractionFinished) {
      await postUnavailableIfChanged("coverage", requestSequence)
    } else {
      await postClearIfChanged("pending", requestSequence)
    }

    return
  }

  const event = findTimelineEvent(time)

  if (isExpiredOrEmpty(event, time)) {
    await postClearIfChanged(event?.kind ?? "empty", requestSequence)

    return
  }

  if (event === null) {
    await postClearIfChanged("empty", requestSequence)

    return
  }

  await renderCompositionEvent(event, requestSequence)
}

function isExpiredOrEmpty(event: TimelineEvent | null, time: number): boolean {
  return (
    event === null ||
    event.kind !== "composition" ||
    (event.duration !== null && time >= event.time + event.duration)
  )
}

async function renderCompositionEvent(
  event: TimelineEvent,
  requestSequence: number
): Promise<void> {
  const visualKey = `${event.parserIndex}:${event.time}`

  if (visualKey === lastVisualKey) {
    postHold(requestSequence)

    return
  }

  const { composition } = event

  if (composition === null) {
    await postClearIfChanged("missing", requestSequence)

    return
  }

  if (
    event.parserIndex - event.boundaryIndex >
    PGS_LIMITS.maxReplayDisplaySets
  ) {
    await postUnavailableIfChanged(String(event.parserIndex), requestSequence)

    return
  }

  const currentParser = requireParser()
  const frame = currentParser.renderAtIndex(event.parserIndex)

  if (frame === undefined) {
    await postClearIfChanged("decode", requestSequence)

    return
  }

  const compositions = readFrameCompositions(frame, composition)

  const rgba = compositePgsFrame(
    composition.width,
    composition.height,
    compositions
  )

  await postBitmapFrame(rgba, event, requestSequence)
}

function readFrameCompositions(
  frame: ReturnType<PgsParser["renderAtIndex"]>,
  composition: PgsComposition
): PgsRgbaComposition[] {
  if (frame === undefined) {
    throw new Error("PGS decoder returned no frame.")
  }

  const compositions: PgsRgbaComposition[] = []

  try {
    validateDecodedFrame(frame, composition)

    for (let index = 0; index < frame.compositionCount; index += 1) {
      const decoded = frame.getComposition(index)
      const authored = composition.objects[index]

      if (decoded === undefined || authored === undefined) {
        throw new Error("PGS decoder omitted a referenced object.")
      }

      try {
        compositions.push({
          x: decoded.x,
          y: decoded.y,
          width: decoded.width,
          height: decoded.height,
          rgba: decoded.getRgba().slice(),
          crop: authored.crop,
          window: authored.window,
        })
      } finally {
        decoded.free()
      }
    }
  } finally {
    frame.free()
    requireParser().clearCache()
  }

  return compositions
}

function validateDecodedFrame(
  frame: NonNullable<ReturnType<PgsParser["renderAtIndex"]>>,
  composition: PgsComposition
): void {
  if (
    frame.width !== composition.width ||
    frame.height !== composition.height ||
    frame.compositionCount !== composition.objects.length
  ) {
    throw new Error("PGS decoder output does not match its composition.")
  }
}

async function postBitmapFrame(
  rgba: Uint8ClampedArray,
  event: TimelineEvent,
  requestSequence: number
): Promise<void> {
  const { composition } = event

  if (composition === null) {
    throw new Error("PGS composition is missing before render.")
  }

  const visualKey = `${event.parserIndex}:${event.time}`
  const canvas = new OffscreenCanvas(composition.width, composition.height)
  const context = canvas.getContext("2d", { alpha: true })

  if (context === null) {
    throw new Error("PGS offscreen canvas is unavailable.")
  }

  context.putImageData(
    new ImageData(
      new Uint8ClampedArray(rgba),
      composition.width,
      composition.height
    ),
    0,
    0
  )

  const bitmap = await createImageBitmap(canvas)

  lastVisualKey = visualKey
  awaitingRelease = true
  postToMainThread(
    {
      type: "frame",
      generation,
      sequence: ++renderSequence,
      requestSequence,
      bitmap,
      width: composition.width,
      height: composition.height,
    },
    [bitmap]
  )
}

function findTimelineEvent(time: number): TimelineEvent | null {
  let low = 0
  let high = timeline.length - 1
  let found = -1

  while (low <= high) {
    const middle = Math.floor((low + high) / 2)

    if ((timeline[middle]?.time ?? Number.POSITIVE_INFINITY) <= time) {
      found = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }

  return found < 0 ? null : (timeline[found] ?? null)
}

async function postClearIfChanged(
  key: string,
  requestSequence: number
): Promise<void> {
  if (lastVisualKey === `clear:${key}`) {
    postHold(requestSequence)

    return
  }

  lastVisualKey = `clear:${key}`
  postFrameState("clear", requestSequence)
}

async function postUnavailableIfChanged(
  key: string,
  requestSequence: number
): Promise<void> {
  const visualKey = `unavailable:${key}`

  if (lastVisualKey === visualKey) {
    postHold(requestSequence)

    return
  }

  lastVisualKey = visualKey
  awaitingRelease = true
  postToMainThread({
    type: "unavailable",
    generation,
    sequence: ++renderSequence,
    requestSequence,
  })
}

function postHold(requestSequence: number): void {
  awaitingRelease = true
  postToMainThread({
    type: "hold",
    generation,
    sequence: ++renderSequence,
    requestSequence,
  })
}

function postFrameState(
  type: "clear" | "failed",
  requestSequence: number
): void {
  awaitingRelease = true
  postToMainThread({
    type,
    generation,
    sequence: ++renderSequence,
    requestSequence,
  })
}

function postState(type: "failed", sequence: number): void {
  postToMainThread({
    type,
    generation,
    sequence,
    requestSequence: 0,
  })
}

async function postFailedIfChanged(requestSequence: number): Promise<void> {
  if (lastVisualKey === "failed") {
    postHold(requestSequence)

    return
  }

  lastVisualKey = "failed"
  postFrameState("failed", requestSequence)
}
