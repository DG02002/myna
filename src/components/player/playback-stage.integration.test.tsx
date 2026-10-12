import { act, useCallback, useMemo } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  PlaybackStage,
  type PlaybackStageDependencies,
} from "#/components/player/playback-stage"
import {
  MediabunnyEngine,
  type EngineInit,
  type EngineSeekResult,
  type EngineStateEvent,
} from "#/media/engines/mediabunny-engine"
import {
  clearHistory,
  loadHistory,
  recordPlayedUrl,
  updateHistoryPosition,
} from "#/media/models/history"
import { RESUME_CONFIRMATION_DEADLINE_MS } from "#/media/models/playback-resume"
import type { ProbeResult } from "#/media/probe/metadata-probe"

interface TestPendingSeek {
  operationId: number
  resolve: (result: EngineSeekResult) => void
}

class TestEngine extends MediabunnyEngine {
  private currentTimeValue: number
  private testDuration = 0
  private pausedValue: boolean
  private disposedValue = false
  loadCount: number
  disposeCount = 0
  pauseCount: number
  seekCalls: number[]
  pendingSeeks: TestPendingSeek[]
  private nextOperationId = 0
  private readonly testListeners = new Set<(event: EngineStateEvent) => void>()

  constructor(init: EngineInit) {
    super(init)
    this.currentTimeValue = init.startTime
    this.pausedValue = !init.autoPlay
    this.loadCount = 0
    this.pauseCount = 0
    this.seekCalls = []
    this.pendingSeeks = []
  }

  override get currentTime(): number {
    return this.currentTimeValue
  }

  override get duration(): number {
    return this.testDuration
  }

  override get paused(): boolean {
    return this.pausedValue
  }

  override get seeking(): boolean {
    return this.pendingSeeks.length > 0
  }

  override get ended(): boolean {
    return false
  }

  override get width(): number | null {
    return null
  }

  override get height(): number | null {
    return null
  }

  override get volume(): number {
    return 1
  }

  override get muted(): boolean {
    return false
  }

  override get playbackRate(): number {
    return 1
  }

  setCurrentTimeForTest(time: number): void {
    this.currentTimeValue = time
  }

  override listen(listener: (event: EngineStateEvent) => void): () => void {
    this.testListeners.add(listener)

    return () => this.testListeners.delete(listener)
  }

  override attachCanvas(_canvas: HTMLCanvasElement | null): void {}

  override async load(): Promise<void> {
    this.loadCount += 1
    this.testDuration = 1_000
    this.emit({
      type: "loaded",
      duration: this.testDuration,
      width: null,
      height: null,
      tracks: [],
      selectedAudioTrackId: null,
    })
  }

  override pause(): void {
    this.pauseCount += 1
    this.pausedValue = true
    this.emit({ type: "pause" })
  }

  override async play(): Promise<void> {
    this.pausedValue = false
    this.emit({ type: "playing" })
  }

  override seek(time: number): Promise<EngineSeekResult> {
    this.seekCalls.push(time)
    const operationId = ++this.nextOperationId

    if (this.disposedValue) {
      return Promise.resolve({
        status: "unavailable",
        operationId: null,
        currentTime: this.currentTimeValue,
      })
    }

    if (time !== 0) {
      this.currentTimeValue = time
      const pending = this.pendingSeeks.shift()

      pending?.resolve({
        status: "superseded",
        operationId: pending.operationId,
        currentTime: time,
      })

      return Promise.resolve({
        status: "completed",
        operationId,
        currentTime: time,
      })
    }

    return new Promise((resolve) => {
      this.pendingSeeks.push({ operationId, resolve })
    })
  }

  override setVolume(_volume: number): void {}

  override setMuted(_muted: boolean): void {}

  override setPlaybackRate(_rate: number): void {}

  override dispose(): void {
    if (this.disposedValue) {
      return
    }

    this.disposedValue = true
    this.disposeCount += 1
    this.testListeners.clear()
    super.dispose()
  }

  private emit(event: EngineStateEvent): void {
    for (const listener of this.testListeners) {
      listener(event)
    }
  }
}

interface TestNativeMediaState {
  currentTime: number
  duration: number
  seeking: boolean
  paused: boolean
  assignments: number[]
}

const testEngines: TestEngine[] = []

let nativeMediaStates = new WeakMap<HTMLMediaElement, TestNativeMediaState>()

let savedMediaDescriptors = new Map<string, PropertyDescriptor | undefined>()

const testDependencies: PlaybackStageDependencies = {
  createEngine(init) {
    const engine = new TestEngine(init)
    testEngines.push(engine)

    return engine
  },
  async probeSource(): Promise<ProbeResult> {
    return {
      containerName: "MP4",
      durationSeconds: 1_000,
      tracks: [],
      readMode: "direct",
    }
  },
}

function HistoryBackedStage({ sourceUrl }: { sourceUrl: string }) {
  const source = useMemo(
    () => ({ kind: "direct" as const, url: sourceUrl }),
    [sourceUrl]
  )

  const onPositionChange = useCallback(
    ({ currentTime, reason }: { currentTime: number; reason: string }) => {
      updateHistoryPosition(sourceUrl, reason === "ended" ? 0 : currentTime)
    },
    [sourceUrl]
  )

  const onProbe = useCallback(() => undefined, [])

  const onModeChange = useCallback(() => undefined, [])

  const startTimeSeconds =
    loadHistory().find((entry) => entry.url === sourceUrl)?.positionSeconds ?? 0

  return (
    <PlaybackStage
      key={sourceUrl}
      source={source}
      startTimeSeconds={startTimeSeconds}
      onProbe={onProbe}
      onModeChange={onModeChange}
      onPositionChange={onPositionChange}
      dependencies={testDependencies}
    />
  )
}

let container: HTMLDivElement

let root: Root | undefined

let rootMounted = false

beforeEach(() => {
  testEngines.length = 0
  nativeMediaStates = new WeakMap()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  installNativeMediaTestSurface()

  installMemoryStorage()
  clearHistory()
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  rootMounted = true
})

afterEach(async () => {
  const mountedRoot = root

  if (mountedRoot !== undefined && rootMounted) {
    await act(async () => mountedRoot.unmount())
  }

  rootMounted = false
  container.remove()
  restoreNativeMediaTestSurface()
  vi.useRealTimers()
})

describe("PlaybackStage resume recovery", () => {
  it("keeps history and playback paused while advanced recovery is pending", async () => {
    const url = seedHistory("pending")
    await mountStage(url)
    expect(alert()).not.toBeNull()
    const engine = await moveToAdvancedEngine()

    await clickRecovery()

    expect(noticeText()).toContain("Starting from beginning")
    expect(recoveryButton().disabled).toBe(true)
    expect(alert()?.getAttribute("aria-busy")).toBe("true")
    expect(engine.seekCalls).toEqual([0])
    expect(engine.pendingSeeks).toHaveLength(1)
    expect(engine.paused).toBe(true)
    expect(readStoredPosition(url)).toBe(301)

    await clickRecovery()
    expect(engine.seekCalls).toEqual([0])
    expect(readStoredPosition(url)).toBe(301)
  })

  it("keeps the retry notice after an advanced recovery failure", async () => {
    const url = seedHistory("failed")
    await mountStage(url)
    const engine = await moveToAdvancedEngine()
    await clickRecovery()

    await settleRecovery(engine, {
      status: "failed",
      operationId: 1,
      currentTime: 301,
    })

    expect(noticeText()).toContain("Could not start from beginning")
    expect(recoveryButton().textContent).toBe("Try again")
    expect(recoveryButton().disabled).toBe(false)
    expect(readStoredPosition(url)).toBe(301)
    expect(engine.seekCalls).toEqual([0])
  })

  it("saves zero only after a retry completes at zero and reuses its engine", async () => {
    const url = seedHistory("success")

    await mountStage(url)
    const engine = await moveToAdvancedEngine()

    await runAdvancedRecovery(engine, {
      status: "failed",
      operationId: 1,
      currentTime: 301,
    })

    await clickRecovery()

    expect(readStoredPosition(url)).toBe(301)
    expect(recoveryButton().disabled).toBe(true)

    engine.setCurrentTimeForTest(12)
    await settleRecovery(engine, {
      status: "completed",
      operationId: 2,
      currentTime: 0,
    })

    expect(readStoredPosition(url)).toBe(301)
    expect(noticeText()).toContain("Could not start from beginning")
    expect(engine.seekCalls).toEqual([0, 0])

    await runAdvancedRecovery(
      engine,
      {
        status: "completed",
        operationId: 3,
        currentTime: 0,
      },
      0
    )

    expectSuccessfulAdvancedRecovery(url, engine)

    await unmountStage()
    expect(engine.disposeCount).toBe(1)
  })

  it("ignores superseded recovery and late results after the source changes", async () => {
    const firstUrl = seedHistory("first")
    await mountStage(firstUrl)
    const firstEngine = await moveToAdvancedEngine()
    await clickRecovery()

    await act(async () => {
      await firstEngine.seek(40)
    })

    expect(noticeText()).toContain("Could not start from beginning")
    expect(readStoredPosition(firstUrl)).toBe(301)

    await clickRecovery()
    expect(firstEngine.pendingSeeks).toHaveLength(1)

    const secondUrl = seedHistory("second")
    await mountStage(secondUrl)
    expect(firstEngine.disposeCount).toBe(1)
    expect(alert()).not.toBeNull()

    await settleRecovery(firstEngine, {
      status: "completed",
      operationId: 3,
      currentTime: 0,
    })

    expect(readStoredPosition(firstUrl)).toBe(301)
    expect(readStoredPosition(secondUrl)).toBe(301)
    expect(alert()).not.toBeNull()
    expect(noticeText()).toContain("Could not restore the saved position")
  })

  it("fails at the controlled deadline and ignores a late completion", async () => {
    const url = seedHistory("deadline")
    await mountStage(url)
    const engine = await moveToAdvancedEngine()
    vi.useFakeTimers()

    await clickRecovery()
    await act(async () => {
      vi.advanceTimersByTime(RESUME_CONFIRMATION_DEADLINE_MS)
    })

    expect(noticeText()).toContain("Could not start from beginning")
    expect(readStoredPosition(url)).toBe(301)

    engine.setCurrentTimeForTest(0)
    await settleRecovery(engine, {
      status: "completed",
      operationId: 1,
      currentTime: 0,
    })

    expect(readStoredPosition(url)).toBe(301)
    expect(noticeText()).toContain("Could not start from beginning")
    expect(recoveryButton().textContent).toBe("Try again")
  })

  it("saves native history only after seeked confirms zero", async () => {
    const { url, video, state } = await mountNativeRecovery("native")

    await clickRecovery()

    expect(state.assignments).toEqual([0])
    expect(noticeText()).toContain("Starting from beginning")
    expect(readStoredPosition(url)).toBe(301)

    state.currentTime = 20
    await dispatchNativeEvent(video, "seeked")
    expect(noticeText()).toContain("Could not start from beginning")
    expect(recoveryButton().textContent).toBe("Try again")
    expect(readStoredPosition(url)).toBe(301)

    await clickRecovery()
    state.currentTime = 0
    state.seeking = false
    await dispatchNativeEvent(video, "seeked")

    expect(alert()).toBeNull()
    expect(readStoredPosition(url)).toBe(0)
    expect(state.paused).toBe(true)
  })

  it("ignores a superseded native seek and allows a later retry", async () => {
    const { url, video, state } = await mountNativeRecovery("superseded-native")

    await clickRecovery()
    state.currentTime = 40
    state.seeking = true
    await dispatchNativeEvent(video, "seeking")

    state.currentTime = 0
    state.seeking = false
    await dispatchNativeEvent(video, "seeked")

    expect(alert()).not.toBeNull()
    expect(readStoredPosition(url)).toBe(301)

    await clickRecovery()
    expect(noticeText()).toContain("Starting from beginning")

    state.currentTime = 0
    state.seeking = false
    await dispatchNativeEvent(video, "seeked")

    expect(alert()).toBeNull()
    expect(readStoredPosition(url)).toBe(0)
  })

  it("keeps an unavailable disposed-engine result as a failure", async () => {
    const url = seedHistory("unavailable")
    await mountStage(url)
    const engine = await moveToAdvancedEngine()
    engine.dispose()

    await clickRecovery()
    await act(async () => Promise.resolve())

    expect(noticeText()).toContain("Could not start from beginning")
    expect(recoveryButton().textContent).toBe("Try again")
    expect(readStoredPosition(url)).toBe(301)
    expect(engine.seekCalls).toEqual([0])
    expect(engine.loadCount).toBe(1)
    expect(engine.disposeCount).toBe(1)
  })
})

function seedHistory(label: string): string {
  const url = `https://media.example/${label}.mp4`
  recordPlayedUrl(url)
  updateHistoryPosition(url, 301)

  return url
}

async function mountNativeRecovery(label: string): Promise<{
  url: string
  video: HTMLVideoElement
  state: TestNativeMediaState
}> {
  const url = seedHistory(label)

  await mountStage(url)
  const video = nativeVideo()
  const state = nativeState(video)
  state.duration = 1_000

  return { url, video, state }
}

function expectSuccessfulAdvancedRecovery(
  url: string,
  engine: TestEngine
): void {
  expect(readStoredPosition(url)).toBe(0)
  expect(alert()).toBeNull()
  expect(engine.paused).toBe(true)
  expect(testEngines).toHaveLength(1)
  expect(engine.loadCount).toBe(1)
  expect(engine.disposeCount).toBe(0)
}

async function runAdvancedRecovery(
  engine: TestEngine,
  result: EngineSeekResult,
  currentTime?: number
): Promise<void> {
  await clickRecovery()

  if (currentTime !== undefined) {
    engine.setCurrentTimeForTest(currentTime)
  }

  await settleRecovery(engine, result)
}

async function mountStage(sourceUrl: string): Promise<void> {
  const mountedRoot = root

  if (mountedRoot === undefined) {
    throw new Error("The player test root is not mounted.")
  }

  await act(async () => {
    mountedRoot.render(<HistoryBackedStage sourceUrl={sourceUrl} />)
    await Promise.resolve()
  })
}

async function unmountStage(): Promise<void> {
  const mountedRoot = root

  if (mountedRoot === undefined || !rootMounted) {
    return
  }

  await act(async () => mountedRoot.unmount())
  rootMounted = false
}

async function moveToAdvancedEngine(): Promise<TestEngine> {
  const video = nativeVideo()

  await act(async () => {
    video.dispatchEvent(new Event("error"))
  })

  const engine = testEngines.at(-1)

  if (engine === undefined) {
    throw new Error("The advanced engine was not constructed.")
  }

  expect(engine.loadCount).toBe(1)

  return engine
}

async function clickRecovery(): Promise<void> {
  await act(async () => recoveryButton().click())
}

async function settleRecovery(
  engine: TestEngine,
  result: EngineSeekResult
): Promise<void> {
  const pending = engine.pendingSeeks.shift()

  if (pending === undefined) {
    throw new Error("There is no pending advanced seek to settle.")
  }

  await act(async () => {
    pending.resolve(result)
    await Promise.resolve()
  })
}

async function dispatchNativeEvent(
  video: HTMLVideoElement,
  eventType: "seeking" | "seeked"
): Promise<void> {
  await act(async () => {
    video.dispatchEvent(new Event(eventType))
  })
}

function nativeVideo(): HTMLVideoElement {
  const video = container.querySelector("video")

  if (!(video instanceof HTMLVideoElement)) {
    throw new Error("The player did not render a native video element.")
  }

  return video
}

function nativeState(video: HTMLVideoElement): TestNativeMediaState {
  const state = nativeMediaStates.get(video)

  if (state === undefined) {
    throw new Error("The native video element has no test media state.")
  }

  return state
}

function alert(): HTMLDivElement | null {
  return container.querySelector('[role="alert"]')
}

function noticeText(): string {
  return alert()?.textContent ?? ""
}

function recoveryButton(): HTMLButtonElement {
  const button = alert()?.querySelector("button")

  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(
      `No recovery button was rendered. DOM: ${container.innerHTML}`
    )
  }

  return button
}

function readStoredPosition(sourceUrl: string): number {
  return (
    loadHistory().find((entry) => entry.url === sourceUrl)?.positionSeconds ??
    -1
  )
}

function installMemoryStorage(): void {
  const values = new Map<string, string>()

  const storage: Storage = {
    get length() {
      return values.size
    },
    clear() {
      values.clear()
    },
    getItem(key) {
      return values.get(key) ?? null
    },
    key(index) {
      return [...values.keys()][index] ?? null
    },
    removeItem(key) {
      values.delete(key)
    },
    setItem(key, value) {
      values.set(key, value)
    },
  }

  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: storage,
  })
}

function installNativeMediaTestSurface(): void {
  const mediaPrototype = HTMLMediaElement.prototype

  const mediaProperties = [
    "currentTime",
    "duration",
    "readyState",
    "seeking",
    "paused",
    "error",
    "remote",
    "load",
    "pause",
    "play",
  ]

  const mediaConstants = {
    HAVE_NOTHING: 0,
    HAVE_METADATA: 1,
    HAVE_CURRENT_DATA: 2,
    HAVE_FUTURE_DATA: 3,
    HAVE_ENOUGH_DATA: 4,
  }

  savedMediaDescriptors = new Map(
    mediaProperties.map((property) => [
      property,
      Object.getOwnPropertyDescriptor(mediaPrototype, property),
    ])
  )

  for (const name of Object.keys(mediaConstants)) {
    savedMediaDescriptors.set(
      name,
      Object.getOwnPropertyDescriptor(HTMLMediaElement, name)
    )
  }

  Object.defineProperties(mediaPrototype, {
    currentTime: {
      configurable: true,
      get(this: HTMLMediaElement) {
        return nativeStateFor(this).currentTime
      },
      set(this: HTMLMediaElement, value: number) {
        const state = nativeStateFor(this)
        state.currentTime = value
        state.assignments.push(value)
      },
    },
    duration: {
      configurable: true,
      get(this: HTMLMediaElement) {
        return nativeStateFor(this).duration
      },
    },
    readyState: {
      configurable: true,
      get: () => 1,
    },
    seeking: {
      configurable: true,
      get(this: HTMLMediaElement) {
        return nativeStateFor(this).seeking
      },
    },
    paused: {
      configurable: true,
      get(this: HTMLMediaElement) {
        return nativeStateFor(this).paused
      },
    },
    error: {
      configurable: true,
      get: () => null,
    },
    remote: {
      configurable: true,
      get: (): RemotePlayback =>
        Object.assign(new EventTarget(), {
          state: "disconnected" as const,
          onconnect: null,
          onconnecting: null,
          ondisconnect: null,
          prompt: async () => undefined,
          watchAvailability: async () => 0,
          cancelWatchAvailability: async () => undefined,
        }),
    },
    load: {
      configurable: true,
      value: () => undefined,
    },
    pause: {
      configurable: true,
      value(this: HTMLMediaElement) {
        nativeStateFor(this).paused = true
      },
    },
    play: {
      configurable: true,
      value(this: HTMLMediaElement) {
        nativeStateFor(this).paused = false

        return Promise.resolve()
      },
    },
  })

  for (const [name, value] of Object.entries(mediaConstants)) {
    Object.defineProperty(HTMLMediaElement, name, {
      configurable: true,
      value,
    })
  }
}

function restoreNativeMediaTestSurface(): void {
  const mediaPrototype = HTMLMediaElement.prototype

  for (const [property, descriptor] of savedMediaDescriptors) {
    const target = property.startsWith("HAVE_")
      ? HTMLMediaElement
      : mediaPrototype

    if (descriptor === undefined) {
      Reflect.deleteProperty(target, property)
    } else {
      Object.defineProperty(target, property, descriptor)
    }
  }
}

function nativeStateFor(media: HTMLMediaElement): TestNativeMediaState {
  const current = nativeMediaStates.get(media)

  if (current !== undefined) {
    return current
  }

  const state: TestNativeMediaState = {
    currentTime: 0,
    duration: 200,
    seeking: false,
    paused: true,
    assignments: [],
  }

  nativeMediaStates.set(media, state)

  return state
}
