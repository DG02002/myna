import assert from "node:assert/strict"
import { test } from "node:test"

import { MediabunnyEngine, type EngineInit } from "./mediabunny-engine"

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
  connect: (destination: TestGain) => void
  start: (when: number) => void
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
  audioSink: TestAudioSink | null
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
    connect: (_destination) => {},
    start: () => {},
    stop: () => node.finish(),
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
