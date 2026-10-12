import assert from "node:assert/strict"
import { test } from "node:test"

import type { AudioBufferSink, CanvasSink, InputVideoTrack } from "mediabunny"

import { MediaDiagnostics } from "../models/diagnostics"
import {
  MediabunnyEngine,
  type EngineInit,
  type EngineStateEvent,
  type MediabunnyEngineDependencies,
} from "./mediabunny-engine"

const EXPECTED_AUDIO_QUEUE_CAPACITY = 32

const FLOOD_AUDIO_BUFFER_COUNT = 128

interface Latch {
  promise: Promise<void>
  release: () => void
}

interface TestAudioBuffer {
  duration: number
}

interface TestWrappedAudioBuffer {
  buffer: TestAudioBuffer
  timestamp: number
}

interface TestGain {
  connected: true
}

interface TestAudioNode {
  buffer: TestAudioBuffer | null
  playbackRate: { value: number }
  startCalls: { when: number; offset?: number }[]
  stopped: boolean
  connect: (destination: TestGain) => void
  start: (when: number, offset?: number) => void
  stop: () => void
  disconnect: () => void
  addEventListener: (
    type: "ended",
    listener: () => void,
    options: { once: true }
  ) => void
  finish: () => void
}

interface TestAudioContext {
  state: "running"
  currentTime: number
  close: () => Promise<void>
  createBufferSource: () => TestAudioNode
}

interface AudioRun {
  started: Latch
  release: () => void
  iterator: AsyncGenerator<TestWrappedAudioBuffer, void, unknown>
}

interface TestAudioSink {
  buffers: (
    startTime: number
  ) => AsyncGenerator<TestWrappedAudioBuffer, void, unknown>
}

interface TestCanvasFrame {
  canvas: HTMLCanvasElement
  duration: number
  timestamp: number
}

interface PendingCanvasFrame {
  time: number
  resolve: (frame: TestCanvasFrame | null) => void
  reject: (error: Error) => void
}

interface ControlledCanvasReader {
  createCanvasSink: MediabunnyEngineDependencies["createCanvasSink"]
  requests: PendingCanvasFrame[]
  waitForRequest: (index: number) => Promise<void>
}

interface TestCanvasInstallation {
  createCanvas: () => HTMLCanvasElement
  restore: () => void
}

interface EngineInternals extends Pick<MediabunnyEngine, "dispose"> {
  input: {
    getPrimaryVideoTrack: () => Promise<null>
    getAudioTracks: () => Promise<TestInputAudioTrack[]>
    getPrimaryAudioTrack: () => Promise<TestInputAudioTrack | null>
    getDurationFromMetadata: () => Promise<number>
    dispose: () => void
  } | null
  loadTracks: () => Promise<void>
  audioContext: TestAudioContext | null
  videoTrack: InputVideoTrack | null
  displayCanvas: HTMLCanvasElement | null
  lastBlittedTimestamp: number
  audioSink: TestAudioSink | null
  buffering: boolean
  videoTick: (() => void) | null
  durationValue: number
  masterGain: object | null
  playing: boolean
  selectedAudioTrack: { type: "audio"; number: number } | null
  tracksValue: { id: string; kind: "audio" | "video"; label: string }[]
  notifyLoaded: () => void
  startAudio: (startTime: number) => Promise<void>
  stopAudio: () => void
  finishIfPlaybackTimeReachedEnd: (currentTime: number) => boolean
}

interface TestInputAudioTrack {
  type: "audio"
  number: number
  getCodecParameterString: () => Promise<string>
  getLanguageCode: () => Promise<string>
}

interface EngineHarness {
  engine: MediabunnyEngine
  internals: EngineInternals
  context: TestAudioContext
  nodes: TestAudioNode[]
  queueAtCapacity: Latch
  queueAdvanced: Latch
}

interface PlaybackScenario {
  engine: MediabunnyEngine
  internals: EngineInternals
  context: TestAudioContext
  audioRuns: [AudioRun, AudioRun]
  tasks: Promise<void>[]
}

void test("keeps only the newest bounded playback diagnostic records", () => {
  let now = 0
  const diagnostics = new MediaDiagnostics(() => now++)

  for (let mediaTime = 0; mediaTime < 125; mediaTime += 1) {
    diagnostics.record({ stage: "source", event: "ready", mediaTime })
  }

  const snapshot = diagnostics.snapshot()

  assert.equal(snapshot.length, 100)
  assert.equal(snapshot[0]?.mediaTime, 25)
  assert.equal(snapshot.at(-1)?.mediaTime, 124)
  assert.equal(JSON.stringify(snapshot).includes("url"), false)
})

function createLatch(): Latch {
  let resolvePromise: (() => void) | undefined

  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve
  })

  const release = () => {
    const resolve = resolvePromise

    if (resolve !== undefined) {
      resolvePromise = undefined
      resolve()
    }
  }

  return { promise, release }
}

function createAudioNode(): TestAudioNode {
  let onEnded: (() => void) | undefined

  const node: TestAudioNode = {
    buffer: null,
    playbackRate: { value: 1 },
    startCalls: [],
    stopped: false,
    connect: (_destination) => {},
    start(when, offset) {
      node.startCalls.push(offset === undefined ? { when } : { when, offset })
    },
    stop() {
      node.stopped = true
      node.finish()
    },
    disconnect: () => {},
    addEventListener(_type, listener) {
      onEnded = listener
    },
    finish() {
      const callback = onEnded
      onEnded = undefined
      callback?.()
    },
  }

  return node
}

function createAudioRun(): AudioRun {
  const started = createLatch()
  const release = createLatch()

  const iterator = (async function* (): AsyncGenerator<
    TestWrappedAudioBuffer,
    void,
    unknown
  > {
    started.release()

    yield* []

    await release.promise
  })()

  return { started, release: release.release, iterator }
}

function accessInternals(
  engine: Pick<MediabunnyEngine, "dispose">
): EngineInternals {
  // SAFETY: The test supplies only the initialized runtime fields used by startAudio.
  return engine as EngineInternals
}

function createEngine(): EngineHarness {
  const init: EngineInit = {
    source: { kind: "direct", url: "https://example.invalid/video.mkv" },
    startTime: 0,
    autoPlay: false,
    volume: 1,
    muted: false,
    playbackRate: 1,
    audioTrackId: null,
  }

  const engine = new MediabunnyEngine(init)
  const internals = accessInternals(engine)
  const nodes: TestAudioNode[] = []
  const queueAtCapacity = createLatch()
  const queueAdvanced = createLatch()

  const context: TestAudioContext = {
    state: "running",
    currentTime: 0,
    close: async () => {},
    createBufferSource() {
      const node = createAudioNode()
      nodes.push(node)

      if (nodes.length === EXPECTED_AUDIO_QUEUE_CAPACITY) {
        queueAtCapacity.release()
      }

      if (nodes.length === EXPECTED_AUDIO_QUEUE_CAPACITY + 1) {
        queueAdvanced.release()
      }

      return node
    },
  }

  internals.audioContext = context
  internals.audioSink = null
  internals.durationValue = 60
  internals.masterGain = { connected: true }
  internals.playing = true
  internals.selectedAudioTrack = { type: "audio", number: 1 }
  internals.tracksValue = []

  return { engine, internals, context, nodes, queueAtCapacity, queueAdvanced }
}

interface PublicAudioContext extends TestAudioContext {
  destination: object
  createGain: () => {
    connected: true
    gain: { value: number }
    connect: () => void
  }
  waitForNodeCount: (count: number) => Promise<void>
}

interface PublicAudioHarness {
  context: PublicAudioContext
  nodes: TestAudioNode[]
}

function createPublicAudioContext(): PublicAudioHarness {
  const nodes: TestAudioNode[] = []
  const waiters = new Map<number, Latch>()

  const context: PublicAudioContext = {
    state: "running",
    currentTime: 0,
    destination: {},
    close: async () => {},
    createGain: () => ({
      connected: true,
      gain: { value: 1 },
      connect: () => {},
    }),
    createBufferSource() {
      const node = createAudioNode()
      nodes.push(node)

      for (const [count, waiter] of waiters) {
        if (nodes.length >= count) {
          waiter.release()
          waiters.delete(count)
        }
      }

      return node
    },
    waitForNodeCount(count) {
      if (nodes.length >= count) {
        return Promise.resolve()
      }

      let waiter = waiters.get(count)

      if (waiter === undefined) {
        waiter = createLatch()
        waiters.set(count, waiter)
      }

      return new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => {
          waiters.delete(count)
          reject(
            new Error(`No decoded audio node arrived before the deadline.`)
          )
        }, 2_000)

        void waiter.promise.then(() => {
          clearTimeout(deadline)
          resolve()
        })
      })
    },
  }

  return { context, nodes }
}

function createPublicAudioEngine(
  context: PublicAudioContext,
  audioSink: TestAudioSink,
  createCanvasSink?: MediabunnyEngineDependencies["createCanvasSink"],
  startTime = 0
): MediabunnyEngine {
  const audioTrack: TestInputAudioTrack = {
    type: "audio",
    number: 1,
    getCodecParameterString: async () => "opus",
    getLanguageCode: async () => "eng",
  }

  const input = {
    getPrimaryVideoTrack: async () => null,
    getAudioTracks: async () => [audioTrack],
    getPrimaryAudioTrack: async () => audioTrack,
    getDurationFromMetadata: async () => 60,
    computeDuration: async () => 60,
    dispose: () => {},
  }

  const injectedContext: unknown = context
  const injectedAudioSink: unknown = audioSink

  const dependencies: Partial<MediabunnyEngineDependencies> = {
    createInput: async (_source, attachInput) => {
      attachInput(input)

      return input
    },
    createAudioContext: () => {
      // SAFETY: The fake exposes every AudioContext member used by these audio-only tests.
      return injectedContext as AudioContext
    },
    createAudioSink: async () => {
      // SAFETY: The controlled sink emits only the buffer timing used by the fake AudioContext.
      return injectedAudioSink as AudioBufferSink
    },
  }

  if (createCanvasSink !== undefined) {
    dependencies.createCanvasSink = createCanvasSink
  }

  return new MediabunnyEngine(
    {
      source: {
        kind: "direct",
        url: "https://example.invalid/video.mkv",
      },
      startTime,
      autoPlay: false,
      volume: 1,
      muted: false,
      playbackRate: 1,
      audioTrackId: null,
    },
    dependencies
  )
}

function createControlledCanvasReader(): ControlledCanvasReader {
  const requests: PendingCanvasFrame[] = []
  const waiters = new Map<number, Latch>()

  const createCanvasSink: MediabunnyEngineDependencies["createCanvasSink"] =
    async () => {
      const sink = {
        getCanvas(time: number) {
          return new Promise<TestCanvasFrame | null>((resolve, reject) => {
            requests.push({ time, resolve, reject })
            waiters.get(requests.length - 1)?.release()
          })
        },
      } satisfies Pick<CanvasSink, "getCanvas">

      // SAFETY: Paused-seek tests use only getCanvas and return a controlled canvas frame.
      return sink as CanvasSink
    }

  return {
    createCanvasSink,
    requests,
    waitForRequest(index) {
      if (requests.length > index) {
        return Promise.resolve()
      }

      let waiter = waiters.get(index)

      if (waiter === undefined) {
        waiter = createLatch()
        waiters.set(index, waiter)
      }

      return waiter.promise
    },
  }
}

function installTestCanvas(): TestCanvasInstallation {
  const originalDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "HTMLCanvasElement"
  )

  class TestCanvas {
    width = 0
    height = 0

    getContext() {
      return { drawImage: () => {} }
    }
  }

  Object.defineProperty(globalThis, "HTMLCanvasElement", {
    configurable: true,
    value: TestCanvas,
  })

  return {
    createCanvas: () => {
      // SAFETY: The fake implements the canvas members exercised by paused-seek rendering.
      const canvas = Object.create(TestCanvas.prototype) as HTMLCanvasElement
      canvas.width = 1
      canvas.height = 1

      return canvas
    },
    restore() {
      if (originalDescriptor === undefined) {
        Reflect.deleteProperty(globalThis, "HTMLCanvasElement")
      } else {
        Object.defineProperty(
          globalThis,
          "HTMLCanvasElement",
          originalDescriptor
        )
      }
    },
  }
}

function installFakeVideoTrack(engine: MediabunnyEngine): void {
  const internals = accessInternals(engine)

  const fakeTrack = { type: "video" as const, number: 1 } satisfies Pick<
    InputVideoTrack,
    "type" | "number"
  >

  // SAFETY: Injected CanvasSink fakes ignore track fields during paused-seek tests.
  internals.videoTrack = fakeTrack as InputVideoTrack
}

function installAnimationFrameStub(): () => void {
  const requestDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "requestAnimationFrame"
  )

  const cancelDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "cancelAnimationFrame"
  )

  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: () => 1,
  })
  Object.defineProperty(globalThis, "cancelAnimationFrame", {
    configurable: true,
    value: () => {},
  })

  return () => {
    if (requestDescriptor === undefined) {
      Reflect.deleteProperty(globalThis, "requestAnimationFrame")
    } else {
      Object.defineProperty(
        globalThis,
        "requestAnimationFrame",
        requestDescriptor
      )
    }

    if (cancelDescriptor === undefined) {
      Reflect.deleteProperty(globalThis, "cancelAnimationFrame")
    } else {
      Object.defineProperty(
        globalThis,
        "cancelAnimationFrame",
        cancelDescriptor
      )
    }
  }
}

void test("reports the actual audio selection after engine load", () => {
  const harness = createEngine()
  const track = { type: "audio" as const, number: 3 }
  const events: unknown[] = []

  harness.internals.selectedAudioTrack = track
  harness.internals.tracksValue = [
    { id: "audio-3", kind: "audio", label: "Audio 3" },
  ]
  harness.engine.listen((event) => events.push(event))
  harness.internals.notifyLoaded()

  assert.deepEqual(events, [
    {
      type: "loaded",
      duration: 60,
      width: null,
      height: null,
      tracks: [{ id: "audio-3", kind: "audio", label: "Audio 3" }],
      selectedAudioTrackId: "audio-3",
    },
  ])

  harness.engine.dispose()
})

void test("loads the file's primary audio and preserves an explicit selection", async () => {
  const tracks: TestInputAudioTrack[] = [1, 2].map((number) => ({
    type: "audio",
    number,
    getCodecParameterString: async () => "opus",
    getLanguageCode: async () => "eng",
  }))

  for (const audioTrackId of [null, "audio-1"]) {
    const engine = new MediabunnyEngine({
      source: { kind: "direct", url: "https://example.invalid/video.mkv" },
      startTime: 0,
      autoPlay: false,
      volume: 1,
      muted: false,
      playbackRate: 1,
      audioTrackId,
    })

    const internals = accessInternals(engine)

    internals.input = {
      getPrimaryVideoTrack: async () => null,
      getAudioTracks: async () => tracks,
      getPrimaryAudioTrack: async () => tracks[1] ?? null,
      getDurationFromMetadata: async () => 60,
      dispose: () => {},
    }

    await internals.loadTracks()
    assert.equal(engine.selectedAudioTrackId, audioTrackId ?? "audio-2")
    engine.dispose()
  }
})

function connectAudioRuns(
  internals: EngineInternals,
  audioRuns: [AudioRun, AudioRun]
): void {
  let runIndex = 0

  internals.audioSink = {
    buffers(_startTime) {
      const run = audioRuns[runIndex]

      if (run === undefined) {
        throw new Error("Unexpected audio run")
      }

      runIndex += 1

      return run.iterator
    },
  }
}

async function completeRestart(scenario: PlaybackScenario): Promise<void> {
  const [firstRun, secondRun] = scenario.audioRuns
  const { internals, tasks } = scenario
  const oldRunTask = internals.startAudio(0)
  tasks.push(oldRunTask)
  await firstRun.started.promise
  internals.stopAudio()

  const currentRunTask = internals.startAudio(10)
  tasks.push(currentRunTask)
  await secondRun.started.promise
  firstRun.release()
  await oldRunTask
  secondRun.release()
  await currentRunTask
}

async function cleanUpPlayback(scenario: PlaybackScenario): Promise<void> {
  const { audioRuns, engine, internals, tasks } = scenario
  internals.playing = false
  internals.stopAudio()

  for (const run of audioRuns) {
    run.release()
  }

  await Promise.all(tasks)
  engine.dispose()
}

void test("stale audio completion cannot end a restarted playback run", async () => {
  const harness = createEngine()
  const { engine, internals } = harness

  const scenario: PlaybackScenario = {
    engine,
    internals,
    context: harness.context,
    audioRuns: [createAudioRun(), createAudioRun()],
    tasks: [],
  }

  connectAudioRuns(internals, scenario.audioRuns)

  try {
    await completeRestart(scenario)

    assert.equal(scenario.engine.ended, false)
    assert.equal(scenario.engine.paused, false)

    scenario.context.currentTime = 60
    assert.equal(scenario.internals.finishIfPlaybackTimeReachedEnd(60), true)
    assert.equal(scenario.engine.ended, true)
  } finally {
    await cleanUpPlayback(scenario)
  }
})

void test("audio scheduling keeps only a bounded number of buffers queued", async () => {
  const harness = createEngine()
  const { engine, internals, nodes, queueAtCapacity, queueAdvanced } = harness
  let buffersRead = 0

  internals.audioSink = {
    async *buffers(_startTime) {
      for (let index = 0; index < FLOOD_AUDIO_BUFFER_COUNT; index += 1) {
        buffersRead += 1
        yield {
          buffer: { duration: 0.02 },
          timestamp: index * 0.02,
        }
      }
    },
  }

  const task = internals.startAudio(0)

  try {
    await queueAtCapacity.promise
    assert.equal(nodes.length, EXPECTED_AUDIO_QUEUE_CAPACITY)
    assert.equal(buffersRead, EXPECTED_AUDIO_QUEUE_CAPACITY)

    nodes[0]?.finish()
    await queueAdvanced.promise
    assert.equal(buffersRead, EXPECTED_AUDIO_QUEUE_CAPACITY + 1)
  } finally {
    internals.playing = false
    internals.stopAudio()
    await task
    engine.dispose()
  }
})

void test("reschedules queued audio on the shared clock when playback rate changes", async () => {
  const restoreAnimationFrame = installAnimationFrameStub()
  const { context, nodes } = createPublicAudioContext()
  const starts: number[] = []

  const audioSink: TestAudioSink = {
    async *buffers(startTime) {
      starts.push(startTime)
      yield { buffer: { duration: 2 }, timestamp: startTime }
    },
  }

  const engine = createPublicAudioEngine(context, audioSink)
  const events: EngineStateEvent[] = []
  engine.listen((event) => events.push(event))

  try {
    await engine.load()
    assert.ok(events.some((event) => event.type === "loaded"))
    await engine.play()

    try {
      await context.waitForNodeCount(1)
    } catch {
      assert.fail(
        `No audio node arrived; engine events: ${JSON.stringify(events)}`
      )
    }

    context.currentTime = 0.5
    engine.setPlaybackRate(2)

    assert.equal(nodes[0]?.stopped, true)
    await context.waitForNodeCount(2)

    assert.deepEqual(starts, [0])
    assert.equal(nodes[1]?.playbackRate.value, 2)
    assert.deepEqual(nodes[1]?.startCalls, [{ when: 0.5, offset: 0.5 }])

    context.currentTime = 0.75
    engine.setPlaybackRate(0.5)
    assert.equal(nodes[1]?.stopped, true)
    await context.waitForNodeCount(3)

    assert.equal(nodes[2]?.playbackRate.value, 0.5)
    assert.deepEqual(nodes[2]?.startCalls, [{ when: 0.75, offset: 1 }])
    assert.deepEqual(starts, [0])
    assert.deepEqual(
      engine.diagnosticSnapshot
        .filter((record) => record.event === "rate-change")
        .map((record) => record.playbackRate),
      [2, 0.5]
    )
    assert.equal(
      JSON.stringify(engine.diagnosticSnapshot).includes("example.invalid"),
      false
    )
  } finally {
    engine.dispose()
    restoreAnimationFrame()
  }
})

void test("freezes playback while a late audio batch is decoded", async () => {
  const restoreAnimationFrame = installAnimationFrameStub()
  const { context, nodes } = createPublicAudioContext()
  let releaseLateBuffer!: () => void

  const lateBuffer = new Promise<void>((resolve) => {
    releaseLateBuffer = resolve
  })

  const audioSink: TestAudioSink = {
    buffers(startTime) {
      return (async function* () {
        yield { buffer: { duration: 0.25 }, timestamp: startTime }
        await lateBuffer
        yield {
          buffer: { duration: 1 },
          timestamp: startTime + 0.25,
        }
      })()
    },
  }

  const engine = createPublicAudioEngine(context, audioSink)

  try {
    await engine.load()
    await engine.play()
    await context.waitForNodeCount(1)

    context.currentTime = 0.75
    assert.equal(engine.currentTime, 0.25)
    releaseLateBuffer()
    await context.waitForNodeCount(2)

    assert.deepEqual(nodes[1]?.startCalls, [{ when: 0.75 }])
    assert.equal(engine.currentTime, 0.25)
    assert.equal(
      engine.diagnosticSnapshot.some((record) => record.event === "underrun"),
      true
    )
  } finally {
    engine.dispose()
    restoreAnimationFrame()
  }
})

void test("waits for decoded audio and a video frame before starting the clock", async () => {
  const restoreAnimationFrame = installAnimationFrameStub()
  const canvas = installTestCanvas()
  const { context } = createPublicAudioContext()
  const audioStarted = createLatch()
  const audioReady = createLatch()
  const frameStarted = createLatch()
  const frameReady = createLatch()

  const audioSink: TestAudioSink = {
    buffers(startTime) {
      return (async function* () {
        audioStarted.release()
        await audioReady.promise
        yield {
          buffer: { duration: 0.5 },
          timestamp: startTime,
        }
      })()
    },
  }

  const createCanvasSink: MediabunnyEngineDependencies["createCanvasSink"] =
    async () => {
      // SAFETY: The test sink implements only the canvases iterator used by playback priming.
      return {
        canvases(startTime) {
          return (async function* () {
            frameStarted.release()
            await frameReady.promise
            yield {
              canvas: canvas.createCanvas(),
              timestamp: startTime,
              duration: 1 / 30,
            }
          })()
        },
      } as CanvasSink
    }

  const engine = createPublicAudioEngine(context, audioSink, createCanvasSink)
  const events: EngineStateEvent[] = []
  engine.listen((event) => events.push(event))

  try {
    await engine.load()
    installFakeVideoTrack(engine)
    engine.attachCanvas(canvas.createCanvas())

    const playTask = engine.play()
    await Promise.all([audioStarted.promise, frameStarted.promise])
    context.currentTime = 5

    assert.equal(engine.paused, false)
    assert.equal(engine.currentTime, 0)
    assert.equal(
      events.some((event) => event.type === "playing"),
      false
    )

    audioReady.release()
    assert.equal(
      events.some((event) => event.type === "playing"),
      false
    )
    frameReady.release()
    await playTask

    assert.equal(engine.currentTime, 0)
    assert.equal(
      events.some((event) => event.type === "waiting"),
      true
    )
    assert.equal(
      events.some((event) => event.type === "playing"),
      true
    )
  } finally {
    engine.dispose()
    canvas.restore()
    restoreAnimationFrame()
  }
})

void test("waits for the video frame covering a paused seek before playing", async () => {
  const restoreAnimationFrame = installAnimationFrameStub()
  const canvas = installTestCanvas()
  const { context, nodes } = createPublicAudioContext()
  const targetFrameRequested = createLatch()
  const targetFrameReady = createLatch()

  const targetFrame = {
    canvas: canvas.createCanvas(),
    timestamp: 20,
    duration: 1 / 30,
  }

  const audioSink: TestAudioSink = {
    async *buffers(startTime) {
      yield { buffer: { duration: 0.5 }, timestamp: startTime }
    },
  }

  const createCanvasSink: MediabunnyEngineDependencies["createCanvasSink"] =
    async (_track, poolSize) => {
      // SAFETY: The fake implements the two CanvasSink methods used by seek and play.
      return {
        async getCanvas(time) {
          assert.equal(time, 20)

          return targetFrame
        },
        canvases(startTime) {
          assert.ok(
            startTime !== undefined && Math.abs(startTime - 19.9) < 0.000001
          )

          return (async function* () {
            if (poolSize === 1) {
              return
            }

            yield {
              canvas: canvas.createCanvas(),
              timestamp: 19.9,
              duration: 1 / 30,
            }
            targetFrameRequested.release()
            await targetFrameReady.promise
            yield targetFrame
          })()
        },
      } as CanvasSink
    }

  const engine = createPublicAudioEngine(context, audioSink, createCanvasSink)
  const internals = accessInternals(engine)
  const events: EngineStateEvent[] = []
  engine.listen((event) => events.push(event))

  try {
    await engine.load()
    installFakeVideoTrack(engine)
    engine.attachCanvas(canvas.createCanvas())

    await engine.seek(20)
    assert.equal(engine.currentTime, 20)
    assert.equal(internals.lastBlittedTimestamp, 20)

    const playTask = engine.play()

    const preparationStep = await Promise.race([
      playTask.then(() => "play-completed" as const),
      targetFrameRequested.promise.then(
        () => "target-frame-requested" as const
      ),
    ])

    assert.equal(preparationStep, "target-frame-requested")
    context.currentTime = 8
    assert.equal(engine.currentTime, 20)
    assert.equal(nodes.length, 0)
    assert.equal(
      events.some((event) => event.type === "playing"),
      false
    )

    targetFrameReady.release()
    await playTask

    assert.equal(nodes.length, 1)
    assert.deepEqual(nodes[0]?.startCalls, [{ when: 8 }])
    assert.equal(internals.lastBlittedTimestamp, 20)
    assert.equal(
      events.some((event) => event.type === "playing"),
      true
    )

    context.currentTime = 8.25
    assert.equal(engine.currentTime, 20.25)
  } finally {
    targetFrameReady.release()
    engine.dispose()
    canvas.restore()
    restoreAnimationFrame()
  }
})

void test("records a real frame gap and keeps its future frame queued", async () => {
  const restoreAnimationFrame = installAnimationFrameStub()
  const canvas = installTestCanvas()
  const { context } = createPublicAudioContext()

  const audioSink: TestAudioSink = {
    async *buffers(startTime) {
      yield { buffer: { duration: 0.5 }, timestamp: startTime }
    },
  }

  const createCanvasSink: MediabunnyEngineDependencies["createCanvasSink"] =
    async () => {
      // SAFETY: The fake implements only the playback canvas iterator.
      return {
        canvases(startTime) {
          assert.ok(
            startTime !== undefined && Math.abs(startTime - 19.9) < 0.000001
          )

          return (async function* () {
            yield {
              canvas: canvas.createCanvas(),
              timestamp: 19.9,
              duration: 1 / 30,
            }
            yield {
              canvas: canvas.createCanvas(),
              timestamp: 20.2,
              duration: 1 / 30,
            }
          })()
        },
      } as CanvasSink
    }

  const engine = createPublicAudioEngine(
    context,
    audioSink,
    createCanvasSink,
    20
  )

  const internals = accessInternals(engine)
  const events: EngineStateEvent[] = []
  engine.listen((event) => events.push(event))

  try {
    await engine.load()
    installFakeVideoTrack(engine)
    engine.attachCanvas(canvas.createCanvas())

    await engine.play()

    assert.equal(internals.lastBlittedTimestamp, -1)
    assert.equal(
      engine.diagnosticSnapshot.some(
        (record) => record.event === "gap" && record.mediaTime === 20
      ),
      true
    )
    assert.equal(
      events.some((event) => event.type === "playing"),
      true
    )
  } finally {
    engine.dispose()
    canvas.restore()
    restoreAnimationFrame()
  }
})

void test("ends at duration without announcing playback or scheduling audio", async () => {
  const { context, nodes } = createPublicAudioContext()

  const audioSink: TestAudioSink = {
    async *buffers(startTime) {
      yield { buffer: { duration: 0.5 }, timestamp: startTime }
    },
  }

  const engine = createPublicAudioEngine(context, audioSink, undefined, 60)
  const events: EngineStateEvent[] = []
  engine.listen((event) => events.push(event))

  try {
    await engine.load()
    installFakeVideoTrack(engine)

    await engine.play()

    assert.equal(engine.currentTime, 60)
    assert.equal(engine.ended, true)
    assert.equal(engine.paused, true)
    assert.equal(nodes.length, 0)
    assert.equal(
      events.some((event) => event.type === "playing"),
      false
    )
    assert.equal(
      events.some((event) => event.type === "ended"),
      true
    )
    assert.equal(
      engine.diagnosticSnapshot.some(
        (record) => record.event === "end-of-stream" && record.mediaTime === 60
      ),
      true
    )
  } finally {
    engine.dispose()
  }
})

void test("audio-only playback stays paused until first audio is decoded", async () => {
  const restoreAnimationFrame = installAnimationFrameStub()
  const { context, nodes } = createPublicAudioContext()
  const audioRequested = createLatch()
  const releaseAudio = createLatch()

  const audioSink: TestAudioSink = {
    buffers(startTime) {
      return (async function* () {
        audioRequested.release()
        await releaseAudio.promise
        yield {
          buffer: { duration: 0.5 },
          timestamp: startTime,
        }
      })()
    },
  }

  const engine = createPublicAudioEngine(context, audioSink)
  const events: EngineStateEvent[] = []
  engine.listen((event) => events.push(event))

  try {
    await engine.load()
    const playTask = engine.play()
    await audioRequested.promise
    context.currentTime = 4

    assert.equal(engine.currentTime, 0)
    assert.equal(nodes.length, 0)
    assert.equal(
      events.some((event) => event.type === "playing"),
      false
    )

    releaseAudio.release()
    await playTask

    assert.equal(nodes.length, 1)
    assert.equal(engine.currentTime, 0)
  } finally {
    engine.dispose()
    restoreAnimationFrame()
  }
})

void test("pause cancels a pending first-audio play request", async () => {
  const restoreAnimationFrame = installAnimationFrameStub()
  const { context } = createPublicAudioContext()
  const audioRequested = createLatch()
  const releaseAudio = createLatch()

  const audioSink: TestAudioSink = {
    buffers(startTime) {
      return (async function* () {
        audioRequested.release()
        await releaseAudio.promise
        yield {
          buffer: { duration: 0.5 },
          timestamp: startTime,
        }
      })()
    },
  }

  const engine = createPublicAudioEngine(context, audioSink)
  const events: EngineStateEvent[] = []
  engine.listen((event) => events.push(event))

  try {
    await engine.load()
    const playTask = engine.play()
    await audioRequested.promise
    engine.pause()
    await playTask

    assert.equal(engine.paused, true)
    assert.equal(
      events.some((event) => event.type === "playing"),
      false
    )

    releaseAudio.release()
  } finally {
    releaseAudio.release()
    engine.dispose()
    restoreAnimationFrame()
  }
})

void test("starts a video-only timeline after its first frame is decoded", async () => {
  const restoreAnimationFrame = installAnimationFrameStub()
  const canvas = installTestCanvas()
  const { context } = createPublicAudioContext()
  const frameRequested = createLatch()
  const frameReady = createLatch()

  const audioSink: TestAudioSink = {
    async *buffers() {
      yield* []
    },
  }

  const createCanvasSink: MediabunnyEngineDependencies["createCanvasSink"] =
    async () => {
      // SAFETY: The test sink implements only the canvases iterator used by playback priming.
      return {
        canvases(startTime) {
          return (async function* () {
            frameRequested.release()
            await frameReady.promise
            yield {
              canvas: canvas.createCanvas(),
              timestamp: startTime,
              duration: 1 / 30,
            }
          })()
        },
      } as CanvasSink
    }

  const engine = createPublicAudioEngine(context, audioSink, createCanvasSink)
  const internals = accessInternals(engine)

  try {
    await engine.load()
    internals.selectedAudioTrack = null
    installFakeVideoTrack(engine)
    engine.attachCanvas(canvas.createCanvas())

    const playTask = engine.play()
    await frameRequested.promise
    context.currentTime = 4
    assert.equal(engine.currentTime, 0)

    frameReady.release()
    await playTask
    assert.equal(engine.currentTime, 0)

    context.currentTime = 4.25
    assert.equal(engine.currentTime, 0.25)
  } finally {
    engine.dispose()
    canvas.restore()
    restoreAnimationFrame()
  }
})

void test("freezes at audio coverage and resumes after underrun preroll", async () => {
  const restoreAnimationFrame = installAnimationFrameStub()
  const { context, nodes } = createPublicAudioContext()
  const laterBatchRequested = createLatch()
  const releaseLaterBatch = createLatch()

  const audioSink: TestAudioSink = {
    buffers(startTime) {
      return (async function* () {
        yield {
          buffer: { duration: 0.25 },
          timestamp: startTime,
        }
        laterBatchRequested.release()
        await releaseLaterBatch.promise
        yield {
          buffer: { duration: 0.5 },
          timestamp: startTime + 0.25,
        }
      })()
    },
  }

  const engine = createPublicAudioEngine(context, audioSink)
  const internals = accessInternals(engine)
  const events: EngineStateEvent[] = []
  engine.listen((event) => events.push(event))

  try {
    await engine.load()
    await engine.play()
    await laterBatchRequested.promise
    assert.equal(nodes.length, 1)

    context.currentTime = 1
    internals.videoTick?.()
    assert.equal(internals.buffering, true)
    assert.equal(engine.currentTime, 0.25)

    context.currentTime = 5
    assert.equal(engine.currentTime, 0.25)

    releaseLaterBatch.release()
    await context.waitForNodeCount(2)
    assert.equal(internals.buffering, false)
    assert.equal(engine.currentTime, 0.25)
    assert.equal(
      engine.diagnosticSnapshot.some((record) => record.event === "underrun"),
      true
    )
    assert.equal(
      engine.diagnosticSnapshot.some(
        (record) => record.event === "underrun-recovered"
      ),
      true
    )

    context.currentTime = 5.1
    assert.ok(Math.abs(engine.currentTime - 0.35) < 0.000001)
    assert.ok(events.filter((event) => event.type === "waiting").length >= 2)
  } finally {
    engine.dispose()
    restoreAnimationFrame()
  }
})

void test("decoder failure during playback priming remains recoverable", async () => {
  const restoreAnimationFrame = installAnimationFrameStub()
  const { context } = createPublicAudioContext()
  const decodeRequested = createLatch()
  const releaseDecodeFailure = createLatch()

  const audioSink: TestAudioSink = {
    buffers() {
      return (async function* () {
        decodeRequested.release()
        await releaseDecodeFailure.promise
        yield* []
        throw new Error("synthetic decoder failure")
      })()
    },
  }

  const engine = createPublicAudioEngine(context, audioSink)
  const events: EngineStateEvent[] = []
  engine.listen((event) => events.push(event))

  try {
    await engine.load()
    const playTask = engine.play()
    await decodeRequested.promise
    releaseDecodeFailure.release()
    await playTask

    assert.equal(engine.paused, true)
    assert.equal(
      events.some((event) => event.type === "playing"),
      false
    )
    assert.equal(
      events.some((event) => event.type === "error"),
      true
    )
    assert.equal(
      engine.diagnosticSnapshot.some(
        (record) => record.event === "prime-failed"
      ),
      true
    )
  } finally {
    engine.dispose()
    restoreAnimationFrame()
  }
})

void test("an older paused seek cannot paint or fail a newer seek", async () => {
  const canvas = installTestCanvas()

  const { context } = createPublicAudioContext()

  const canvasReader = createControlledCanvasReader()

  const audioSink: TestAudioSink = {
    async *buffers(startTime) {
      yield { buffer: { duration: 1 }, timestamp: startTime }
    },
  }

  const engine = createPublicAudioEngine(
    context,
    audioSink,
    canvasReader.createCanvasSink
  )

  const events: EngineStateEvent[] = []
  const internals = accessInternals(engine)
  engine.listen((event) => events.push(event))

  try {
    await engine.load()
    installFakeVideoTrack(engine)
    engine.attachCanvas(canvas.createCanvas())

    const firstSeek = engine.seek(10)
    await canvasReader.waitForRequest(0)
    const secondSeek = engine.seek(20)
    await canvasReader.waitForRequest(1)

    const [, newerRequest] = canvasReader.requests
    assert.ok(newerRequest)
    newerRequest.resolve({
      canvas: canvas.createCanvas(),
      duration: 1,
      timestamp: 20,
    })
    const newerResult = await secondSeek

    const [olderRequest] = canvasReader.requests
    assert.ok(olderRequest)
    olderRequest.reject(new Error("superseded seek failed"))
    const olderResult = await firstSeek

    assert.equal(newerResult.status, "completed")
    assert.equal(olderResult.status, "superseded")

    assert.deepEqual(
      events.flatMap((event) =>
        event.type === "seeked"
          ? [{ currentTime: event.currentTime, operationId: event.operationId }]
          : []
      ),
      [{ currentTime: 20, operationId: 2 }]
    )
    assert.equal(
      events.some((event) => event.type === "seekfailed"),
      false
    )
    assert.equal(internals.lastBlittedTimestamp, 20)
    assert.equal(engine.currentTime, 20)
    assert.equal(engine.seeking, false)
  } finally {
    engine.dispose()
    canvas.restore()
  }
})

void test("a failed current seek settles without reporting a successful seek", async () => {
  const canvas = installTestCanvas()

  const { context } = createPublicAudioContext()

  const canvasReader = createControlledCanvasReader()

  const audioSink: TestAudioSink = {
    async *buffers(startTime) {
      yield { buffer: { duration: 1 }, timestamp: startTime }
    },
  }

  const engine = createPublicAudioEngine(
    context,
    audioSink,
    canvasReader.createCanvasSink
  )

  const events: EngineStateEvent[] = []
  engine.listen((event) => events.push(event))

  try {
    await engine.load()
    installFakeVideoTrack(engine)
    engine.attachCanvas(canvas.createCanvas())

    const seek = engine.seek(15)
    await canvasReader.waitForRequest(0)

    const [request] = canvasReader.requests
    assert.ok(request)
    request.reject(new Error("target frame failed"))
    const result = await seek

    assert.deepEqual(result, {
      status: "failed",
      operationId: 1,
      currentTime: 0,
    })

    assert.equal(
      events.some((event) => event.type === "seeked"),
      false
    )
    assert.deepEqual(
      events.flatMap((event) =>
        event.type === "seekfailed"
          ? [{ currentTime: event.currentTime, operationId: event.operationId }]
          : []
      ),
      [{ currentTime: 0, operationId: 1 }]
    )
    assert.equal(engine.currentTime, 0)
    assert.equal(engine.seeking, false)
  } finally {
    engine.dispose()
    canvas.restore()
  }
})

void test("does not report an unavailable, disposed, or no-op seek as success", async () => {
  const canvas = installTestCanvas()
  const { context } = createPublicAudioContext()
  const canvasReader = createControlledCanvasReader()

  const audioSink: TestAudioSink = {
    async *buffers(startTime) {
      yield { buffer: { duration: 1 }, timestamp: startTime }
    },
  }

  const engine = createPublicAudioEngine(
    context,
    audioSink,
    canvasReader.createCanvasSink
  )

  try {
    const beforeLoad = await engine.seek(0)
    assert.equal(beforeLoad.status, "unavailable")
    assert.equal(beforeLoad.operationId, null)

    await engine.load()
    installFakeVideoTrack(engine)

    const withoutCanvas = await engine.seek(0)
    assert.equal(withoutCanvas.status, "failed")
    assert.equal(withoutCanvas.operationId, 1)

    engine.dispose()

    const afterDispose = await engine.seek(0)
    assert.equal(afterDispose.status, "unavailable")
    assert.equal(afterDispose.operationId, null)
  } finally {
    engine.dispose()
    canvas.restore()
  }
})

void test("a failed newer seek restores the last confirmed position", async () => {
  const canvas = installTestCanvas()

  const { context } = createPublicAudioContext()

  const canvasReader = createControlledCanvasReader()

  const audioSink: TestAudioSink = {
    async *buffers(startTime) {
      yield { buffer: { duration: 1 }, timestamp: startTime }
    },
  }

  const engine = createPublicAudioEngine(
    context,
    audioSink,
    canvasReader.createCanvasSink
  )

  const events: EngineStateEvent[] = []
  const internals = accessInternals(engine)
  engine.listen((event) => events.push(event))

  try {
    await engine.load()
    installFakeVideoTrack(engine)
    engine.attachCanvas(canvas.createCanvas())

    const olderSeek = engine.seek(10)
    await canvasReader.waitForRequest(0)
    const newerSeek = engine.seek(20)
    await canvasReader.waitForRequest(1)

    const [, newerRequest] = canvasReader.requests
    assert.ok(newerRequest)
    newerRequest.reject(new Error("newer seek failed"))
    await newerSeek

    assert.equal(engine.currentTime, 0)
    assert.equal(engine.seeking, false)
    assert.equal(
      events.some(
        (event) => event.type === "seekfailed" && event.currentTime === 0
      ),
      true
    )

    const [olderRequest] = canvasReader.requests
    assert.ok(olderRequest)
    olderRequest.resolve({
      canvas: canvas.createCanvas(),
      duration: 1,
      timestamp: 10,
    })
    await olderSeek

    assert.equal(engine.currentTime, 0)
    assert.equal(internals.lastBlittedTimestamp, -1)
  } finally {
    engine.dispose()
    canvas.restore()
  }
})
