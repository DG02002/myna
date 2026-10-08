import assert from "node:assert/strict"
import { test } from "node:test"

import type {
  MatroskaAssTrackStream,
  MatroskaSubtitleReader,
} from "#/media/matroska-subtitles"
import type { SubtitleTrack } from "#/media/subtitles"

import { subscribeAssSubtitlePackets } from "./ass-subtitle-overlay"
import { startEmbeddedSubtitleLoad } from "./subtitle-tracks"

type AssPacket = Parameters<
  Parameters<MatroskaAssTrackStream["subscribePackets"]>[0]
>[0][number]

type AssTrackData = Awaited<MatroskaAssTrackStream["result"]>

interface ControlledStream {
  stream: MatroskaAssTrackStream
  emit: (text: string) => void
  finish: () => void
  cancel: () => void
  listenerCount: () => number
  listeners: () => Array<(packets: AssPacket[]) => void>
}

interface EmbeddedLoadRef {
  current: { id: string; controller: AbortController } | null
}

function createControlledStream(): ControlledStream {
  let resolveResult!: (data: AssTrackData) => void
  let rejectResult!: (reason: Error) => void
  const retained: AssPacket[] = []
  const listeners = new Set<(packets: AssPacket[]) => void>()

  const result = new Promise<AssTrackData>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })

  const stream: MatroskaAssTrackStream = {
    metadata: Promise.resolve({ codecPrivate: new Uint8Array(), fonts: [] }),
    result,
    subscribePackets: (listener) => {
      listeners.add(listener)

      if (retained.length > 0) {
        listener(retained)
      }

      return () => listeners.delete(listener)
    },
  }

  return {
    stream,
    emit: (text) => {
      const batch = [
        { data: new TextEncoder().encode(text), startTime: 0, duration: 1 },
      ]

      retained.push(...batch)

      for (const listener of listeners) {
        listener(batch)
      }
    },
    finish: () =>
      resolveResult({
        codecPrivate: new Uint8Array(),
        packets: retained,
        fonts: [],
      }),
    cancel: () => rejectResult(new Error("cancelled")),
    listenerCount: () => listeners.size,
    listeners: () => [...listeners],
  }
}

function createRenderer() {
  const packets: string[] = []

  return {
    packets,
    appendSubtitleChunk(data: Uint8Array) {
      packets.push(new TextDecoder().decode(data))
    },
  }
}

function createLoadHarness(stream: MatroskaAssTrackStream) {
  const track: SubtitleTrack = {
    id: "matroska-2",
    label: "English",
    language: "en",
    source: { kind: "matroska", trackNumber: 2, codecId: "S_TEXT/ASS" },
    status: "available",
    cues: [],
  }

  const loadRef: EmbeddedLoadRef = { current: null }

  let streamStartCount = 0

  const reader: MatroskaSubtitleReader = {
    probe: async () => [],
    readCues: async () => [],
    streamAssTrack: () => {
      streamStartCount++

      return stream
    },
    readAssTrack: async () => stream.result,
  }

  let tracks = [track]
  let currentStream: MatroskaAssTrackStream | null = null
  let currentStreamId: string | null = null

  const setTracks = (
    update: (currentTracks: SubtitleTrack[]) => SubtitleTrack[]
  ) => {
    tracks = update(tracks)
  }

  const setAssTrackStream = (streamValue: MatroskaAssTrackStream | null) => {
    currentStream = streamValue
  }

  const setAssTrackStreamId = (id: string | null) => {
    currentStreamId = id
  }

  const pendingLoad = startEmbeddedSubtitleLoad({
    track,
    reader,
    embeddedLoad: loadRef,
    setTracks,
    setAssTrackStream,
    setAssTrackStreamId,
  })

  assert.ok(pendingLoad)
  const controller = loadRef.current?.controller
  assert.ok(controller)

  return {
    controller,
    currentStream: () => currentStream,
    currentStreamId: () => currentStreamId,
    pendingLoad,
    startAgain: () =>
      startEmbeddedSubtitleLoad({
        track,
        reader,
        embeddedLoad: loadRef,
        setTracks,
        setAssTrackStream,
        setAssTrackStreamId,
      }),
    streamStartCount: () => streamStartCount,
    tracks: () => tracks,
  }
}

void test("stops the old renderer and replays retained and new packets", () => {
  const controlled = createControlledStream()
  const oldRenderer = createRenderer()
  const newRenderer = createRenderer()
  let failures = 0

  const oldCleanup = subscribeAssSubtitlePackets({
    stream: controlled.stream,
    renderer: oldRenderer,
    onFailure: () => failures++,
  })

  controlled.emit("first")
  const [staleListener] = controlled.listeners()

  oldCleanup()
  controlled.emit("second")
  staleListener?.([
    { data: new TextEncoder().encode("raced"), startTime: 0, duration: 1 },
  ])

  const newCleanup = subscribeAssSubtitlePackets({
    stream: controlled.stream,
    renderer: newRenderer,
    onFailure: () => failures++,
  })

  controlled.emit("third")

  assert.deepEqual(oldRenderer.packets, ["first"])
  assert.deepEqual(newRenderer.packets, ["first", "second", "third"])
  assert.equal(failures, 0)
  assert.equal(controlled.listenerCount(), 1)
  newCleanup()
  assert.equal(controlled.listenerCount(), 0)
})

void test("keeps extraction and selection active during renderer migration", async () => {
  const controlled = createControlledStream()
  const load = createLoadHarness(controlled.stream)
  const failures: string[] = []
  const oldRenderer = createRenderer()

  const oldCleanup = subscribeAssSubtitlePackets({
    stream: controlled.stream,
    renderer: oldRenderer,
    onFailure: () => failures.push("old"),
  })

  controlled.emit("before migration")
  oldCleanup()

  assert.equal(load.controller.signal.aborted, false)
  assert.equal(load.tracks()[0]?.status, "loading")
  assert.equal(load.currentStream(), controlled.stream)
  assert.equal(load.currentStreamId(), "matroska-2")
  assert.equal(load.startAgain(), undefined)
  assert.equal(load.streamStartCount(), 1)

  const newRenderer = createRenderer()

  const newCleanup = subscribeAssSubtitlePackets({
    stream: controlled.stream,
    renderer: newRenderer,
    onFailure: () => failures.push("new"),
  })

  controlled.emit("after migration")
  controlled.finish()
  await load.pendingLoad

  assert.equal(load.controller.signal.aborted, false)
  assert.equal(load.tracks()[0]?.status, "ready")
  assert.deepEqual(oldRenderer.packets, ["before migration"])
  assert.deepEqual(newRenderer.packets, ["before migration", "after migration"])
  assert.deepEqual(failures, [])
  newCleanup()
})

void test("replay failure unsubscribes even before subscribe returns", () => {
  const controlled = createControlledStream()

  const failingRenderer = {
    appendSubtitleChunk() {
      throw new Error("renderer failed")
    },
  }

  let failures = 0

  controlled.emit("retained")

  const cleanup = subscribeAssSubtitlePackets({
    stream: controlled.stream,
    renderer: failingRenderer,
    onFailure: () => failures++,
  })

  assert.equal(failures, 1)
  assert.equal(controlled.listenerCount(), 0)
  cleanup()
  assert.equal(controlled.listenerCount(), 0)
})

void test("cancellation cleans up the overlay subscription without failing", async () => {
  const controlled = createControlledStream()
  const load = createLoadHarness(controlled.stream)
  let failures = 0

  const cleanup = subscribeAssSubtitlePackets({
    stream: controlled.stream,
    renderer: createRenderer(),
    onFailure: () => failures++,
  })

  controlled.emit("before cancellation")
  cleanup()
  load.controller.abort()
  controlled.cancel()
  await load.pendingLoad

  assert.equal(controlled.listenerCount(), 0)
  assert.equal(load.controller.signal.aborted, true)
  assert.notEqual(load.tracks()[0]?.status, "failed")
  assert.equal(failures, 0)
})
