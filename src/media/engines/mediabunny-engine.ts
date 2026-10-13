// Mediabunny playback core: decodes video to canvases and audio to Web Audio
// buffers over a lazily-read remote Input. The audio context clock is the
// single playback clock; video frames blit when the clock reaches them.
//
// Remote access mirrors the probe: direct UrlSource first, the same-origin
// proxy when CORS blocks byte reads.
import type {
  AudioBufferSink,
  CanvasSink,
  Input,
  InputAudioTrack,
  InputVideoTrack,
  WrappedAudioBuffer,
  WrappedCanvas,
} from "mediabunny"

import { MediaDiagnostics } from "../models/diagnostics"
import type { PlaybackFailure } from "../models/media-errors"
import type { PlaybackSource } from "../models/source"
import { proxiedMediaUrl } from "../proxy/proxied-url"
import {
  type AdvancedReadDiagnostic,
  AdvancedMediaReadError,
  AdvancedMediaReadPolicy,
  isProxyFallbackFailure,
} from "../read-policy"

export interface EngineTrack {
  id: string
  kind: "video" | "audio"
  label: string
  languageCode: string
}

export interface EngineInit {
  source: PlaybackSource
  startTime: number
  autoPlay: boolean
  volume: number
  muted: boolean
  playbackRate: number
  audioTrackId: string | null
}

export interface MediabunnyEngineDependencies {
  createInput: (
    source: PlaybackSource,
    attachInput: (input: EngineInput) => void
  ) => Promise<EngineInput>
  createAudioContext: () => AudioContext
  createAudioSink: (track: EngineAudioTrack) => Promise<AudioBufferSink>
  createCanvasSink: (
    track: InputVideoTrack,
    poolSize: number,
    preferHardware: boolean
  ) => Promise<CanvasSink>
}

interface EngineInput {
  dispose: () => void
  getPrimaryVideoTrack: () => Promise<InputVideoTrack | null>
  getAudioTracks: () => Promise<EngineAudioTrack[]>
  getPrimaryAudioTrack: () => Promise<EngineAudioTrack | null>
  getDurationFromMetadata: () => Promise<number | null>
  computeDuration: () => Promise<number>
}

interface EngineAudioTrack {
  type: "audio" | "subtitle" | "video"
  number: number
  getCodecParameterString: () => Promise<string | null>
  getLanguageCode: () => Promise<string>
}

export type EngineStateEvent =
  | {
      type: "loaded"
      duration: number
      width: number | null
      height: number | null
      tracks: EngineTrack[]
      selectedAudioTrackId: string | null
    }
  | { type: "timeupdate"; currentTime: number }
  | { type: "seeking"; operationId: number }
  | { type: "seeked"; currentTime: number; operationId: number }
  | { type: "seekfailed"; currentTime: number; operationId: number }
  | { type: "play" }
  | { type: "preparing"; currentTime: number }
  | { type: "prepared"; currentTime: number }
  | { type: "waiting" }
  | { type: "playing" }
  | { type: "pause" }
  | { type: "ended" }
  | { type: "volumechange" }
  | { type: "ratechange" }
  | {
      type: "error"
      code: number
      message: string
      failure?: PlaybackFailure
    }

export interface EngineSeekResult {
  status: "completed" | "failed" | "superseded" | "unavailable"
  operationId: number | null
  currentTime: number
}

// Kept near two frames: the canvas pool is a ring buffer, so queueing more
// frames than the pool lets later decodes overwrite queued canvases.
const VIDEO_LOOKAHEAD_SECONDS = 0.1

const CANVAS_POOL_SIZE = 4

const MAX_QUEUED_AUDIO_BUFFERS = 32

const MIN_AUDIO_PREROLL_SECONDS = 0.15

const TIMEUPDATE_INTERVAL_MS = 250

const MEDIA_ERR_NETWORK = 2

const MEDIA_ERR_DECODE = 3

const MEDIA_ERR_SRC_NOT_SUPPORTED = 4

class NoPlayableTracksError extends Error {
  constructor() {
    super("The file contains no playable video or audio tracks")
    this.name = "NoPlayableTracksError"
  }
}

interface ActiveAudioNode {
  node: AudioBufferSourceNode
  ended: Promise<void>
  buffer: AudioBuffer
  timestamp: number
}

interface AudioBufferSchedule {
  startAt: number
  sourceOffset: number
}

interface AudioNodeSchedule extends AudioBufferSchedule {
  buffer: AudioBuffer
  timestamp: number
  gain: GainNode
}

interface SeekOperation {
  id: number
  targetTime: number
  previousTime: number
  wasPlaying: boolean
}

interface AudioRunToken {
  generation: number
  audioGeneration: number
}

interface PlaybackCancellation {
  requestId: number
  promise: Promise<null>
  cancel: () => void
}

interface AudioSelectionOperation {
  operationId: number
  supersedingCommittedSelection: boolean
}

interface CancellationSignal {
  promise: Promise<null>
  cancel: () => void
}

interface PreparedAudio {
  iterator: AsyncGenerator<WrappedAudioBuffer> | null
  buffers: WrappedAudioBuffer[]
  exhausted: boolean
}

interface PreparedVideo {
  iterator: AsyncGenerator<WrappedCanvas> | null
  firstFrame: WrappedCanvas | null
  gap: boolean
}

type VideoFrameReadiness =
  | { kind: "invalid" }
  | { kind: "expired" }
  | { kind: "covering"; frame: WrappedCanvas }
  | { kind: "gap"; frame: WrappedCanvas }
  | { kind: "after-end" }

interface PreparedPlayback {
  audio: PreparedAudio
  video: PreparedVideo
}

type ScheduledAudioBuffer = Pick<WrappedAudioBuffer, "buffer" | "timestamp">

function classifyVideoFrame(
  frame: WrappedCanvas,
  requestedTime: number,
  duration: number
): VideoFrameReadiness {
  const frameEnd = frame.timestamp + frame.duration

  if (
    !Number.isFinite(frame.timestamp) ||
    !Number.isFinite(frame.duration) ||
    frame.duration <= 0 ||
    !Number.isFinite(frameEnd)
  ) {
    return { kind: "invalid" }
  }

  if (frame.timestamp <= requestedTime && requestedTime < frameEnd) {
    return { kind: "covering", frame }
  }

  if (frame.timestamp > requestedTime) {
    return frame.timestamp >= duration
      ? { kind: "after-end" }
      : { kind: "gap", frame }
  }

  return { kind: "expired" }
}

function createCancellationSignal(): CancellationSignal {
  let resolveCancellation!: (result: null) => void

  const promise = new Promise<null>((resolve) => {
    resolveCancellation = resolve
  })

  return { promise, cancel: () => resolveCancellation(null) }
}

async function createInputFor(
  source: PlaybackSource,
  callbacks: CreateInputCallbacks
): Promise<{ input: Input; readMode: "direct" | "proxy" }> {
  const { attachInput, isCanceled, onReadDiagnostic, onReadMode } = callbacks

  const {
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
  } = await import("mediabunny")

  const formats = [MP4, MATROSKA, WEBM, MP3, WAVE, OGG, ADTS, FLAC, MPEG_TS]

  // Default UrlSource parallelism is 2: after a distant seek, reads at the
  // target can queue behind workers still prefetching the pre-seek region
  // (running workers are only evicted when idle). Four workers keep the
  // seek target from waiting on stale speculation.
  const readPolicy = new AdvancedMediaReadPolicy({
    onDiagnostic: onReadDiagnostic,
  })

  const sourceOptions = {
    ...readPolicy.urlSourceOptions,
    parallelism: 4,
  }

  const createInputAt = async (
    url: string,
    readMode: "direct" | "proxy"
  ): Promise<{ input: Input; readMode: "direct" | "proxy" }> => {
    const input = new Input({
      formats,
      source: new UrlSource(url, sourceOptions),
    })

    attachInput(input)

    try {
      onReadMode(readMode)
      await input.getFormat()

      return { input, readMode }
    } catch (failure) {
      input.dispose()

      throw failure
    }
  }

  try {
    return await createInputAt(source.url, "direct")
  } catch (error) {
    if (
      isCanceled() ||
      !(error instanceof Error) ||
      !isProxyFallbackFailure(error)
    ) {
      throw error
    }

    // Only browser-blocked byte access needs the proxy. Readable HTTP and
    // invalid-range failures keep their original cause.
    return createInputAt(proxiedMediaUrl(source.url), "proxy")
  }
}

interface CreateInputCallbacks {
  attachInput: (input: Input) => void
  isCanceled: () => boolean
  onReadDiagnostic: (diagnostic: AdvancedReadDiagnostic) => void
  onReadMode: (mode: "direct" | "proxy") => void
}

function loadErrorCode(failure: Error, hasInput: boolean): number {
  if (failure instanceof AdvancedMediaReadError) {
    return MEDIA_ERR_NETWORK
  }

  if (
    failure instanceof NoPlayableTracksError ||
    failure.name === "UnsupportedInputFormatError"
  ) {
    return MEDIA_ERR_SRC_NOT_SUPPORTED
  }

  return hasInput ? MEDIA_ERR_DECODE : MEDIA_ERR_NETWORK
}

function playbackFailureFor(
  failure: Error,
  hasInput: boolean
): PlaybackFailure {
  if (failure instanceof AdvancedMediaReadError) {
    switch (failure.kind) {
      case "aborted":
        return { kind: "playback-aborted" }
      case "byte-access-unavailable":
        return { kind: "byte-access-unavailable" }
      case "http":
        return { kind: "upstream-http", status: failure.status ?? 0 }
      case "invalid-range":
        return { kind: "invalid-range" }
      case "timeout":
        return { kind: "read-timeout" }
      case "truncated":
        return { kind: "read-truncated" }
      case "invalid-response":
      case "network":
        return { kind: "network" }
    }
  }

  if (
    failure instanceof NoPlayableTracksError ||
    failure.name === "UnsupportedInputFormatError"
  ) {
    return { kind: "unsupported-container" }
  }

  return hasInput ? { kind: "decode" } : { kind: "network" }
}

// Registers the focused WASM decoder only when the selected audio track
// needs it, so AAC/Opus playback never downloads the WASM bundle.
async function ensureAudioDecoderRegistered(
  track: EngineAudioTrack
): Promise<void> {
  const codec = await track.getCodecParameterString()

  if (
    codec !== null &&
    (codec.startsWith("ec-3") || codec.startsWith("ac-3"))
  ) {
    const { registerAc3Decoder } = await import("@mediabunny/ac3")

    registerAc3Decoder()
  }

  if (codec?.startsWith("dts")) {
    const { registerDtsDecoder } = await import("@mediabunny/dts")

    registerDtsDecoder()
  }
}

export class MediabunnyEngine {
  private readonly init: EngineInit
  private readonly dependencies: MediabunnyEngineDependencies
  private readonly diagnostics = new MediaDiagnostics()
  private readonly listeners: ((event: EngineStateEvent) => void)[] = []

  private disposed = false
  private generation = 0
  private videoGeneration = 0
  private audioGeneration = 0
  private seekOperationId = 0
  private audioSelectionOperationId = 0
  private audioSelectionPending = false
  private audioSelectionCommitted = false
  private audioSelectionShouldPlay = false
  private seekRecoveryTime: number
  private playbackRequestId = 0
  private playbackCancellation: PlaybackCancellation | null = null
  private pausedPreparationActive = false
  private pausedPreparationRequestId = 0
  private pausedPreparationPromise: Promise<PreparedPlayback | null> | null =
    null
  private pausedPreparedPlayback: {
    time: number
    prepared: PreparedPlayback
  } | null = null
  private readModeValue: "direct" | "proxy" | "custom" | "unknown" = "unknown"
  private decodedVideoThroughValue: number | null = null

  private input: EngineInput | null = null
  private audioContext: AudioContext | null = null
  private masterGain: GainNode | null = null

  private videoTrack: InputVideoTrack | null = null
  private audioTracks: EngineAudioTrack[] = []
  private selectedAudioTrack: EngineAudioTrack | null = null

  private canvasIterator: AsyncGenerator<WrappedCanvas> | null = null
  private audioSink: AudioBufferSink | null = null
  private audioIterator: AsyncGenerator<WrappedAudioBuffer> | null = null

  private displayCanvas: HTMLCanvasElement | null = null
  private frameQueue: {
    canvas: HTMLCanvasElement | OffscreenCanvas
    timestamp: number
  }[] = []
  private lastBlittedTimestamp = -1
  private pullingFrame = false

  private anchorContextTime = 0
  private anchorMediaTime = 0
  private frozenMediaTime = 0
  private playing = false
  private playPending = false
  private buffering = false
  private endedFlag = false
  private audioFeedExhausted = false
  private seekingFlag = false
  private volumeValue = 1
  private mutedValue = false
  private rateValue = 1
  private durationValue = 0
  private widthValue: number | null = null
  private heightValue: number | null = null

  private activeAudioNodes: ActiveAudioNode[] = []
  private pendingAudioBuffers: ScheduledAudioBuffer[] = []
  private renderFrame: number | null = null
  private videoTick: (() => void) | null = null
  private lastTimeupdateAt = 0
  private tracksValue: EngineTrack[] = []

  // True once this audio run has scheduled its first buffer; the first
  // buffer re-anchors the clock, later ones must not.
  private audioRunPrimed = false

  // Context time at which the last scheduled audio node ends, so a late
  // batch of buffers serializes instead of stacking on the same instant.
  private lastScheduledAudioEnd = 0

  constructor(
    init: EngineInit,
    dependencies: Partial<MediabunnyEngineDependencies> = {}
  ) {
    this.init = init
    this.readModeValue =
      dependencies.createInput === undefined ? "unknown" : "custom"
    this.dependencies = {
      createInput:
        dependencies.createInput ??
        (async (source, attachInput) => {
          const { input: mediaInput } = await createInputFor(source, {
            attachInput,
            isCanceled: () => this.disposed,
            onReadMode: (mode) => {
              this.readModeValue = mode
            },
            onReadDiagnostic: (diagnostic) => {
              if (this.disposed) {
                return
              }

              this.diagnostics.record({
                stage: "source",
                event: diagnostic.event,
                readErrorKind: diagnostic.kind,
                retryAttempt: diagnostic.attempt,
                httpStatus: diagnostic.status ?? undefined,
                retryAfterMs: diagnostic.retryAfterMs ?? undefined,
                byteCount: diagnostic.byteCount,
                rangeStart: diagnostic.rangeStart,
              })
            },
          })

          return mediaInput
        }),
      createAudioContext:
        dependencies.createAudioContext ?? (() => new AudioContext()),
      createAudioSink:
        dependencies.createAudioSink ??
        (async (track) => {
          const { AudioBufferSink: Sink } = await import("mediabunny")

          // SAFETY: EngineAudioTrack is the subset exposed by real Mediabunny audio tracks.
          return new Sink(track as InputAudioTrack)
        }),
      createCanvasSink:
        dependencies.createCanvasSink ??
        (async (track, poolSize, preferHardware) => {
          const { CanvasSink: Sink } = await import("mediabunny")

          const options = { poolSize }

          if (preferHardware) {
            return new Sink(track, {
              ...options,
              decoderOptions: { hardwareAcceleration: "prefer-hardware" },
            })
          }

          return new Sink(track, options)
        }),
    }
    this.frozenMediaTime = init.startTime
    this.seekRecoveryTime = init.startTime
    this.volumeValue = init.volume
    this.mutedValue = init.muted
    this.rateValue = init.playbackRate
  }

  listen(listener: (event: EngineStateEvent) => void): () => void {
    this.listeners.push(listener)

    return () => {
      const index = this.listeners.indexOf(listener)

      if (index !== -1) {
        this.listeners.splice(index, 1)
      }
    }
  }

  private notify(event: EngineStateEvent): void {
    for (const listener of this.listeners.slice()) {
      listener(event)
    }
  }

  attachCanvas(canvas: HTMLCanvasElement | null): void {
    this.displayCanvas = canvas
  }

  async load(): Promise<void> {
    this.diagnostics.record({ stage: "source", event: "loading" })

    try {
      await this.openInput()

      if (this.disposed) {
        return
      }

      await this.loadTracks()

      if (this.disposed) {
        return
      }

      this.createAudioContext()
      this.notifyLoaded()
      this.diagnostics.record({
        stage: "source",
        event: "ready",
        mediaTime: this.frozenMediaTime,
      })

      if (this.init.autoPlay) {
        await this.play()
      } else if (
        !this.seekingFlag &&
        this.frozenMediaTime < this.durationValue
      ) {
        void this.preparePausedPlayback(this.frozenMediaTime, true)
      }
    } catch (error) {
      if (this.disposed) {
        return
      }

      const failure =
        error instanceof Error ? error : new Error("Media engine failed.")

      const code = loadErrorCode(failure, this.input !== null)

      this.fail(
        failure.message,
        code,
        playbackFailureFor(failure, this.input !== null)
      )
      this.diagnostics.record({
        stage: "source",
        event: "failed",
        errorCode: code,
      })
    }
  }

  private preparePausedPlayback(
    fromTime: number,
    failEngine: boolean
  ): Promise<PreparedPlayback | null> {
    this.clearPausedPreparation(true)
    const requestId = ++this.playbackRequestId
    this.pausedPreparationRequestId = requestId
    this.pausedPreparationActive = true
    this.diagnostics.record({
      stage: "playback",
      event: "priming",
      mediaTime: fromTime,
    })
    this.notify({ type: "preparing", currentTime: fromTime })

    const preparation = this.preparePlayback(fromTime, requestId)
      .then((prepared) => {
        if (!this.isCurrentPlaybackRequest(requestId)) {
          return null
        }

        this.pausedPreparationActive = false
        this.pausedPreparedPlayback = { time: fromTime, prepared }

        if (prepared.video.firstFrame !== null) {
          this.recordDecodedFrame(prepared.video.firstFrame)
          this.lastBlittedTimestamp = prepared.video.firstFrame.timestamp

          if (!prepared.video.gap) {
            this.blit(prepared.video.firstFrame.canvas)
          }
        }

        this.diagnostics.record({
          stage: "playback",
          event: "primed",
          mediaTime: fromTime,
        })
        this.notify({ type: "prepared", currentTime: fromTime })

        return prepared
      })
      .catch((error) => {
        if (!this.isCurrentPlaybackRequest(requestId)) {
          return null
        }

        this.pausedPreparationActive = false

        const failure =
          error instanceof Error
            ? error
            : new Error("Media preparation failed.")

        const code = loadErrorCode(failure, this.input !== null)

        this.diagnostics.record({
          stage: "playback",
          event: "prime-failed",
          errorCode: code,
        })

        if (failEngine) {
          this.fail(
            failure.message,
            code,
            playbackFailureFor(failure, this.input !== null)
          )
        }

        return null
      })
      .finally(() => {
        if (this.pausedPreparationPromise === preparation) {
          this.pausedPreparationPromise = null
        }
      })

    this.pausedPreparationPromise = preparation

    return preparation
  }

  private async openInput(): Promise<void> {
    const input = await this.dependencies.createInput(
      this.init.source,
      (nextInput) => {
        this.input = nextInput

        if (this.disposed) {
          nextInput.dispose()
        }
      }
    )

    if (this.disposed) {
      input.dispose()

      return
    }

    this.input = input
  }

  private createAudioContext(): void {
    this.audioContext = this.dependencies.createAudioContext()
    this.masterGain = this.audioContext.createGain()
    this.masterGain.connect(this.audioContext.destination)
    this.applyGain()
  }

  private notifyLoaded(): void {
    this.notify({
      type: "loaded",
      duration: this.durationValue,
      width: this.widthValue,
      height: this.heightValue,
      tracks: this.trackList(),
      selectedAudioTrackId: this.selectedAudioTrackId,
    })
  }

  private async loadTracks(): Promise<void> {
    const { input } = this

    if (input === null) {
      return
    }

    this.videoTrack = await input.getPrimaryVideoTrack()
    this.audioTracks = await input.getAudioTracks()

    if (this.audioTracks.length === 0 && this.videoTrack === null) {
      throw new NoPlayableTracksError()
    }

    this.selectedAudioTrack =
      this.audioTracks.find(
        (track) => this.trackId(track) === this.init.audioTrackId
      ) ?? (await input.getPrimaryAudioTrack())

    if (this.selectedAudioTrack !== null) {
      await ensureAudioDecoderRegistered(this.selectedAudioTrack)
    }

    this.durationValue =
      (await input.getDurationFromMetadata()) ?? (await input.computeDuration())

    if (this.videoTrack !== null) {
      this.widthValue = await this.videoTrack.getDisplayWidth()
      this.heightValue = await this.videoTrack.getDisplayHeight()
    }

    this.tracksValue = await this.buildTrackList()
  }

  private async buildTrackList(): Promise<EngineTrack[]> {
    const video: EngineTrack[] = []

    if (this.videoTrack !== null) {
      video.push({
        id: this.trackId(this.videoTrack),
        kind: "video",
        label: "Video",
        languageCode: await this.videoTrack.getLanguageCode(),
      })
    }

    return [
      ...video,
      ...(await Promise.all(
        this.audioTracks.map(async (track): Promise<EngineTrack> => {
          return {
            id: this.trackId(track),
            kind: "audio",
            label: `Audio ${track.number}`,
            languageCode: await track.getLanguageCode(),
          }
        })
      )),
    ]
  }

  trackId(track: EngineAudioTrack | InputVideoTrack): string {
    return `${track.type}-${track.number}`
  }

  trackList(): EngineTrack[] {
    return this.tracksValue
  }

  get duration(): number {
    return this.durationValue
  }

  get width(): number | null {
    return this.widthValue
  }

  get height(): number | null {
    return this.heightValue
  }

  get paused(): boolean {
    return !this.playing && !this.playPending
  }

  get ended(): boolean {
    return this.endedFlag
  }

  get currentTime(): number {
    if (!this.playing || this.buffering || this.audioContext === null) {
      return this.frozenMediaTime
    }

    return Math.min(this.currentMediaTime(), this.durationValue)
  }

  // Audio scheduled into Web Audio is the advanced engine's measurable
  // playback buffer. A video-only source has no audio runway to report.
  get bufferedAheadSeconds(): number | null {
    if (this.audioContext === null || this.selectedAudioTrack === null) {
      return null
    }

    if (!this.playing) {
      return 0
    }

    return Math.max(
      0,
      this.lastScheduledAudioEnd - this.audioContext.currentTime
    )
  }

  get volume(): number {
    return this.volumeValue
  }

  get muted(): boolean {
    return this.mutedValue
  }

  get playbackRate(): number {
    return this.rateValue
  }

  get selectedAudioTrackId(): string | null {
    return this.selectedAudioTrack === null
      ? null
      : this.trackId(this.selectedAudioTrack)
  }

  get diagnosticSnapshot() {
    return this.diagnostics.snapshot()
  }

  get readMode(): "direct" | "proxy" | "custom" | "unknown" {
    return this.readModeValue
  }

  get requestedStartTime(): number {
    return this.init.startTime
  }

  get confirmedPosition(): number {
    return this.seekRecoveryTime
  }

  get latestSeekOperationId(): number | null {
    return this.seekOperationId === 0 ? null : this.seekOperationId
  }

  get decodedVideoThroughSeconds(): number | null {
    return this.decodedVideoThroughValue
  }

  get seeking(): boolean {
    return this.seekingFlag
  }

  async play(): Promise<void> {
    if (this.audioSelectionPending) {
      this.audioSelectionShouldPlay = true

      if (this.audioSelectionCommitted) {
        return
      }
    }

    if (
      this.disposed ||
      this.playing ||
      this.playPending ||
      this.input === null
    ) {
      return
    }

    if (this.audioContext === null || this.masterGain === null) {
      return
    }

    this.endedFlag = false

    const requestId = this.pausedPreparationActive
      ? this.pausedPreparationRequestId
      : ++this.playbackRequestId

    const cancellation = this.createPlaybackCancellation(requestId)
    this.playPending = true
    this.notify({ type: "play" })
    this.notify({ type: "waiting" })

    await this.resumeAndStartPlayback(requestId, cancellation)
  }

  private async resumeAndStartPlayback(
    requestId: number,
    cancellation: PlaybackCancellation
  ): Promise<void> {
    const context = this.audioContext

    if (context === null) {
      return
    }

    await this.resumeAudioContext(context, cancellation)

    if (!this.isCurrentPlaybackRequest(requestId)) {
      return
    }

    if (context.state !== "running") {
      this.pauseForSuspendedAudioContext(requestId)

      return
    }

    if (this.commitCachedPausedPreparation()) {
      return
    }

    if (await this.commitPendingPausedPreparation(requestId, cancellation)) {
      return
    }

    this.clearPlaybackCancellation(requestId)
    await this.startPlayback(this.frozenMediaTime, true)
  }

  private async resumeAudioContext(
    context: AudioContext,
    cancellation: PlaybackCancellation
  ): Promise<void> {
    if (context.state !== "suspended") {
      return
    }

    await Promise.race([
      context.resume().catch(() => {
        // Autoplay policy: the context needs a user gesture. Stay paused
        // with a frame on screen; the skin's play button starts playback.
      }),
      cancellation.promise,
    ])
  }

  private pauseForSuspendedAudioContext(requestId: number): void {
    this.playPending = false
    this.clearPlaybackCancellation(requestId)
    void this.blitFrameAt(this.frozenMediaTime)
    this.notify({ type: "pause" })
  }

  private commitCachedPausedPreparation(): boolean {
    const cached = this.pausedPreparedPlayback

    if (
      cached === null ||
      Math.abs(cached.time - this.frozenMediaTime) >= 0.001
    ) {
      return false
    }

    this.clearPlaybackCancellation(this.playbackRequestId)
    this.pausedPreparedPlayback = null
    this.pausedPreparationActive = false
    this.commitPreparedPlayback(cached.time, cached.prepared)

    return true
  }

  private async commitPendingPausedPreparation(
    requestId: number,
    cancellation: PlaybackCancellation
  ): Promise<boolean> {
    const preparation = this.pausedPreparationPromise

    if (preparation === null) {
      return false
    }

    const result = await Promise.race([
      preparation.then((prepared) => ({ prepared })),
      cancellation.promise,
    ])

    if (
      result === null ||
      !this.isCurrentPlaybackRequest(requestId) ||
      result.prepared === null
    ) {
      return true
    }

    this.clearPlaybackCancellation(requestId)
    this.pausedPreparedPlayback = null
    this.pausedPreparationActive = false
    this.commitPreparedPlayback(this.frozenMediaTime, result.prepared)

    return true
  }

  pause(): void {
    if (this.audioSelectionPending) {
      this.audioSelectionShouldPlay = false
    }

    if (!this.playing && !this.playPending) {
      return
    }

    if (this.playing) {
      this.frozenMediaTime = this.currentMediaTime()
    }

    this.cancelPendingPlayback()
    this.clearPausedPreparation(false)
    this.playbackRequestId += 1
    this.playing = false
    this.playPending = false
    this.buffering = false
    this.stopPlayback()
    this.notify({ type: "pause" })
  }

  setVolume(volume: number): void {
    this.volumeValue = volume
    this.applyGain()
    this.notify({ type: "volumechange" })
  }

  setMuted(muted: boolean): void {
    this.mutedValue = muted
    this.applyGain()
    this.notify({ type: "volumechange" })
  }

  setPlaybackRate(rate: number): void {
    if (!this.playing) {
      this.rateValue = rate
      this.diagnostics.record({
        stage: "audio",
        event: "rate-change",
        mediaTime: this.frozenMediaTime,
        playbackRate: rate,
      })
      this.notify({ type: "ratechange" })

      return
    }

    this.frozenMediaTime = this.currentMediaTime()
    this.rateValue = rate
    this.reanchor(this.frozenMediaTime)
    this.rescheduleAudioQueue()
    this.diagnostics.record({
      stage: "audio",
      event: "rate-change",
      mediaTime: this.frozenMediaTime,
      playbackRate: rate,
    })
    this.notify({ type: "ratechange" })
  }

  async seek(time: number): Promise<EngineSeekResult> {
    if (!Number.isFinite(time)) {
      return {
        status: "failed",
        operationId: null,
        currentTime: this.currentTime,
      }
    }

    if (
      this.disposed ||
      this.input === null ||
      this.audioContext === null ||
      this.durationValue <= 0
    ) {
      return {
        status: "unavailable",
        operationId: null,
        currentTime: this.currentTime,
      }
    }

    const operation = this.beginSeek(time)

    try {
      const completed = await this.performSeek(operation)

      if (!this.isCurrentSeek(operation.id) || completed === null) {
        return {
          status: this.disposed ? "unavailable" : "superseded",
          operationId: operation.id,
          currentTime: this.currentTime,
        }
      }

      if (completed) {
        this.completeSeek(operation)

        return {
          status: "completed",
          operationId: operation.id,
          currentTime: operation.targetTime,
        }
      }

      this.failSeek(operation)

      return {
        status: "failed",
        operationId: operation.id,
        currentTime: operation.previousTime,
      }
    } catch {
      if (this.isCurrentSeek(operation.id)) {
        this.failSeek(operation)

        return {
          status: "failed",
          operationId: operation.id,
          currentTime: operation.previousTime,
        }
      }

      return {
        status: this.disposed ? "unavailable" : "superseded",
        operationId: operation.id,
        currentTime: this.currentTime,
      }
    } finally {
      if (this.isCurrentSeek(operation.id)) {
        this.seekingFlag = false
      }
    }
  }

  private beginSeek(time: number): SeekOperation {
    this.clearPausedPreparation(true)
    const targetTime = Math.max(0, Math.min(time, this.durationValue))
    const wasPlaying = this.playing || this.playPending

    if (!this.seekingFlag) {
      this.seekRecoveryTime = this.playing
        ? this.currentMediaTime()
        : this.frozenMediaTime
    }

    const previousTime = this.seekRecoveryTime

    const id = ++this.seekOperationId

    this.seekingFlag = true
    this.diagnostics.record({
      stage: "seek",
      event: "seeking",
      mediaTime: targetTime,
      operationId: id,
    })
    this.notify({ type: "seeking", operationId: id })

    if (wasPlaying) {
      this.cancelPendingPlayback()
      this.playbackRequestId += 1
      this.playing = false
      this.playPending = false
      this.stopPlayback()
    }

    this.frozenMediaTime = targetTime
    this.endedFlag = false

    return { id, targetTime, previousTime, wasPlaying }
  }

  private async performSeek(operation: SeekOperation): Promise<boolean | null> {
    const context = this.audioContext

    if (this.videoTrack !== null && this.displayCanvas === null) {
      return false
    }

    if (operation.wasPlaying && context !== null) {
      if (context.state === "suspended") {
        await context.resume().catch(() => {
          // Same autoplay-policy hole as play(): without a running
          // context there is no clock to resume onto.
        })
      }

      if (!this.isCurrentSeek(operation.id)) {
        return null
      }

      if (context.state === "running") {
        const started = await this.startPlayback(operation.targetTime)

        if (!this.isCurrentSeek(operation.id)) {
          return null
        }

        return started
      }
    }

    if (operation.targetTime >= this.durationValue) {
      return true
    }

    const prepared = await this.preparePausedPlayback(
      operation.targetTime,
      false
    )

    return prepared !== null && this.isCurrentSeek(operation.id)
  }

  private completeSeek(operation: SeekOperation): void {
    this.seekRecoveryTime = operation.targetTime
    this.seekingFlag = false
    this.diagnostics.record({
      stage: "seek",
      event: "seeked",
      mediaTime: operation.targetTime,
      operationId: operation.id,
    })
    this.notify({
      type: "seeked",
      currentTime: operation.targetTime,
      operationId: operation.id,
    })
  }

  private failSeek(operation: SeekOperation): void {
    this.frozenMediaTime = operation.previousTime
    this.seekRecoveryTime = operation.previousTime
    this.seekingFlag = false
    this.diagnostics.record({
      stage: "seek",
      event: "failed",
      mediaTime: operation.targetTime,
      operationId: operation.id,
    })
    this.notify({
      type: "seekfailed",
      currentTime: operation.previousTime,
      operationId: operation.id,
    })
  }

  // One-shot frame decode so seeking while paused still moves the picture.
  private async blitFrameAt(
    time: number,
    seekOperationId?: number
  ): Promise<boolean> {
    const track = this.videoTrack
    const { generation } = this
    const operationId = seekOperationId ?? this.seekOperationId

    if (track === null || this.displayCanvas === null) {
      return track === null && this.audioTracks.length > 0
    }

    if (time >= this.durationValue) {
      this.diagnostics.record({
        stage: "video",
        event: "end-of-stream",
        mediaTime: time,
      })

      return true
    }

    const sink = await this.dependencies.createCanvasSink(track, 1, false)

    if (
      this.disposed ||
      generation !== this.generation ||
      !this.isCurrentSeek(operationId)
    ) {
      return false
    }

    // Paused-seek decode is cosmetic: on failure the previous frame stays
    // on screen, and the next seek or play retries with a fresh sink.
    const wrapped = await sink.getCanvas(time).catch(() => null)

    if (
      this.disposed ||
      generation !== this.generation ||
      !this.isCurrentSeek(operationId)
    ) {
      return false
    }

    if (wrapped === null) {
      return false
    }

    this.recordDecodedFrame(wrapped)
    this.lastBlittedTimestamp = wrapped.timestamp
    this.blit(wrapped.canvas)

    return true
  }

  private isCurrentSeek(operationId: number): boolean {
    return !this.disposed && operationId === this.seekOperationId
  }

  private isCurrentAudioSelection(operationId: number): boolean {
    return !this.disposed && operationId === this.audioSelectionOperationId
  }

  // A playing track switch re-primes both media sinks from one frozen time so
  // neither side advances while the new audio decoder is getting ready.
  async selectAudioTrack(trackId: string): Promise<void> {
    const track = this.audioTracks.find(
      (candidate) => this.trackId(candidate) === trackId
    )

    if (track === undefined) {
      return
    }

    if (this.cancelPendingAudioSelectionForCurrentTrack(track)) {
      return
    }

    const selection = this.beginAudioTrackSelection()

    try {
      await ensureAudioDecoderRegistered(track)

      if (!this.isCurrentAudioSelection(selection.operationId)) {
        return
      }

      await this.commitAudioTrackSelection(track, selection.operationId)
    } catch (error) {
      if (!this.isCurrentAudioSelection(selection.operationId)) {
        return
      }

      if (selection.supersedingCommittedSelection) {
        await this.resumeCommittedAudioSelection()
      }

      throw error
    } finally {
      this.finishAudioTrackSelection(selection.operationId)
    }
  }

  private cancelPendingAudioSelectionForCurrentTrack(
    track: EngineAudioTrack
  ): boolean {
    if (track !== this.selectedAudioTrack) {
      return false
    }

    if (this.audioSelectionPending && !this.audioSelectionCommitted) {
      this.audioSelectionOperationId += 1
      this.audioSelectionPending = false
      this.audioSelectionShouldPlay = false
    }

    return true
  }

  private beginAudioTrackSelection(): AudioSelectionOperation {
    const operationId = ++this.audioSelectionOperationId

    const supersedingCommittedSelection =
      this.audioSelectionPending && this.audioSelectionCommitted

    const shouldPlay = this.audioSelectionPending
      ? this.audioSelectionShouldPlay
      : this.playing || this.playPending

    if (supersedingCommittedSelection) {
      this.stopCommittedAudioSelection()
    }

    this.audioSelectionPending = true
    this.audioSelectionCommitted = false
    this.audioSelectionShouldPlay = shouldPlay

    return { operationId, supersedingCommittedSelection }
  }

  private stopCommittedAudioSelection(): void {
    this.frozenMediaTime = this.playing
      ? this.currentMediaTime()
      : this.frozenMediaTime
    this.cancelPendingPlayback()
    this.clearPausedPreparation(true)
    this.playbackRequestId += 1
    this.playing = false
    this.playPending = false
    this.buffering = false
    this.stopPlayback()
  }

  private async commitAudioTrackSelection(
    track: EngineAudioTrack,
    operationId: number
  ): Promise<void> {
    const resumeTime = this.playing
      ? this.currentMediaTime()
      : this.frozenMediaTime

    this.frozenMediaTime = resumeTime
    this.cancelPendingPlayback()
    this.clearPausedPreparation(false)
    this.playbackRequestId += 1
    this.playing = false
    this.playPending = false
    this.buffering = false

    // Stop unconditionally: a run may still be filling asynchronously even
    // while paused, and its iterator must be returned before the reference
    // is dropped or its WASM decoder and fetches leak.
    this.stopPlayback()

    this.selectedAudioTrack = track
    this.audioSink = null
    this.audioIterator = null
    this.audioSelectionCommitted = true

    if (this.audioSelectionShouldPlay && this.audioContext !== null) {
      await this.startPlayback(this.frozenMediaTime)

      return
    }

    await this.preparePausedPlayback(this.frozenMediaTime, true)

    if (
      this.isCurrentAudioSelection(operationId) &&
      this.audioSelectionShouldPlay &&
      this.audioContext !== null
    ) {
      await this.startPlayback(this.frozenMediaTime)
    }
  }

  private async resumeCommittedAudioSelection(): Promise<void> {
    if (this.audioSelectionShouldPlay && this.audioContext !== null) {
      await this.startPlayback(this.frozenMediaTime)
    } else {
      await this.preparePausedPlayback(this.frozenMediaTime, true)
    }
  }

  private finishAudioTrackSelection(operationId: number): void {
    if (!this.isCurrentAudioSelection(operationId)) {
      return
    }

    this.audioSelectionPending = false
    this.audioSelectionCommitted = false
    this.audioSelectionShouldPlay = false
  }

  dispose(): void {
    if (this.disposed) {
      return
    }

    this.disposed = true
    this.generation += 1
    this.audioSelectionOperationId += 1
    this.audioSelectionPending = false
    this.audioSelectionCommitted = false
    this.audioSelectionShouldPlay = false
    this.cancelPendingPlayback()
    this.clearPausedPreparation(false)
    this.playbackRequestId += 1
    this.playing = false
    this.playPending = false
    this.stopPlayback()
    this.input?.dispose()
    void this.audioContext?.close().catch(() => {
      // Closing can reject once the context is already closed; nothing to
      // release at that point.
    })
  }

  private currentMediaTime(): number {
    if (this.audioContext === null || this.buffering) {
      return this.frozenMediaTime
    }

    const clockTime =
      this.anchorMediaTime +
      (this.audioContext.currentTime - this.anchorContextTime) * this.rateValue

    if (
      this.playing &&
      this.selectedAudioTrack !== null &&
      !this.audioFeedExhausted &&
      this.audioRunPrimed &&
      this.lastScheduledAudioEnd > 0
    ) {
      const audioCoverageEnd =
        this.anchorMediaTime +
        (this.lastScheduledAudioEnd - this.anchorContextTime) * this.rateValue

      return Math.min(clockTime, audioCoverageEnd)
    }

    return clockTime
  }

  private reanchor(mediaTime: number): void {
    if (this.audioContext !== null) {
      this.anchorContextTime = this.audioContext.currentTime
    }

    this.anchorMediaTime = mediaTime
  }

  private applyGain(): void {
    if (this.masterGain !== null) {
      this.masterGain.gain.value = this.mutedValue ? 0 : this.volumeValue
    }
  }

  private async startPlayback(
    fromTime: number,
    waitingAlready = false
  ): Promise<boolean> {
    this.clearPausedPreparation(true)
    const requestId = ++this.playbackRequestId

    const cancellation = this.beginPlaybackPreparation(
      fromTime,
      requestId,
      waitingAlready
    )

    if (fromTime >= this.durationValue) {
      this.clearPlaybackCancellation(requestId)
      this.finishPlaybackAtEndOfStream()

      return true
    }

    try {
      const result = await Promise.race([
        this.preparePlayback(fromTime, requestId).then((prepared) => ({
          prepared,
        })),
        cancellation.promise,
      ])

      if (result === null || !this.isCurrentPlaybackRequest(requestId)) {
        return false
      }

      this.clearPlaybackCancellation(requestId)
      this.commitPreparedPlayback(fromTime, result.prepared)

      return true
    } catch (error) {
      if (!this.isCurrentPlaybackRequest(requestId)) {
        return false
      }

      this.clearPlaybackCancellation(requestId)
      this.failPlaybackPreparation(
        error instanceof Error ? error : new Error("Media playback failed.")
      )

      return false
    }
  }

  private beginPlaybackPreparation(
    fromTime: number,
    requestId: number,
    waitingAlready: boolean
  ): PlaybackCancellation {
    this.cancelPendingPlayback()
    this.stopPlayback()
    this.playing = false
    this.playPending = true
    this.buffering = false
    const cancellation = this.createPlaybackCancellation(requestId)

    if (!waitingAlready) {
      this.notify({ type: "waiting" })
    }

    this.diagnostics.record({
      stage: "playback",
      event: "priming",
      mediaTime: fromTime,
    })

    return cancellation
  }

  private commitPreparedPlayback(
    fromTime: number,
    prepared: PreparedPlayback
  ): void {
    this.pausedPreparationActive = false
    this.pausedPreparationRequestId = 0
    this.pausedPreparationPromise = null
    this.pausedPreparedPlayback = null
    this.playPending = false
    this.playing = true
    this.frozenMediaTime = fromTime
    this.reanchor(fromTime)
    this.audioFeedExhausted = prepared.audio.exhausted
    this.audioRunPrimed = true
    this.pendingAudioBuffers = []

    this.startPreparedPlaybackMedia(fromTime, prepared)
    this.publishPreparedPlayback(fromTime)
  }

  private startPreparedPlaybackMedia(
    fromTime: number,
    prepared: PreparedPlayback
  ): void {
    if (prepared.video.gap) {
      this.diagnostics.record({
        stage: "video",
        event: "gap",
        mediaTime: fromTime,
      })
    }

    if (prepared.video.firstFrame !== null) {
      this.recordDecodedFrame(prepared.video.firstFrame)
    }

    for (const wrapped of prepared.audio.buffers) {
      this.scheduleAudioBuffer(wrapped.buffer, wrapped.timestamp)
    }

    this.startPreparedAudioRun(fromTime, prepared.audio)
    this.startPreparedVideoRun(prepared.video)
  }

  private publishPreparedPlayback(fromTime: number): void {
    this.diagnostics.record({
      stage: "playback",
      event: "primed",
      mediaTime: fromTime,
    })
    this.notify({ type: "prepared", currentTime: fromTime })
    this.notify({ type: "playing" })
  }

  private startPreparedAudioRun(fromTime: number, audio: PreparedAudio): void {
    if (audio.iterator === null || audio.exhausted) {
      return
    }

    this.audioIterator = audio.iterator

    const run = {
      generation: this.generation,
      audioGeneration: this.audioGeneration,
    }

    void this.runAudioTask(
      this.startAudio(fromTime, audio.iterator),
      run.generation,
      run.audioGeneration
    )
  }

  private startPreparedVideoRun(video: PreparedVideo): void {
    const run = {
      generation: this.generation,
      videoGeneration: this.videoGeneration,
    }

    void this.runVideoTask(
      this.startVideoLoop(video),
      run.generation,
      run.videoGeneration
    )
  }

  private failPlaybackPreparation(failure: Error): void {
    const code = loadErrorCode(failure, this.input !== null)
    this.playPending = false
    this.playing = false
    this.stopPlayback()
    this.notify({ type: "pause" })
    this.diagnostics.record({
      stage: "playback",
      event: "prime-failed",
      errorCode: code,
    })
    this.fail(
      failure.message,
      code,
      playbackFailureFor(failure, this.input !== null)
    )
  }

  private finishPlaybackAtEndOfStream(): void {
    this.playPending = false
    this.playing = false
    this.buffering = false
    this.frozenMediaTime = this.durationValue
    this.endedFlag = true
    this.stopPlayback()

    if (this.videoTrack !== null) {
      this.diagnostics.record({
        stage: "video",
        event: "end-of-stream",
        mediaTime: this.durationValue,
      })
    }

    this.notify({ type: "timeupdate", currentTime: this.durationValue })
    this.notify({ type: "pause" })
    this.notify({ type: "ended" })
  }

  private async preparePlayback(
    fromTime: number,
    requestId: number
  ): Promise<PreparedPlayback> {
    const [audio, video] = await Promise.all([
      this.prepareAudio(fromTime, requestId),
      this.prepareVideo(fromTime, requestId),
    ])

    return { audio, video }
  }

  private async prepareAudio(
    fromTime: number,
    requestId: number
  ): Promise<PreparedAudio> {
    if (this.selectedAudioTrack === null) {
      return { iterator: null, buffers: [], exhausted: true }
    }

    if (
      !(await this.ensureAudioSink()) ||
      !this.isCurrentPlaybackRequest(requestId)
    ) {
      return { iterator: null, buffers: [], exhausted: true }
    }

    const iterator = this.audioSink?.buffers(fromTime)

    if (iterator === undefined) {
      throw new Error("The selected audio track could not be prepared")
    }

    this.audioIterator = iterator

    return this.readAudioPreroll(iterator, fromTime, requestId)
  }

  private async readAudioPreroll(
    iterator: AsyncGenerator<WrappedAudioBuffer>,
    fromTime: number,
    requestId: number
  ): Promise<PreparedAudio> {
    const buffers: WrappedAudioBuffer[] = []
    let exhausted = false

    while (buffers.length < MAX_QUEUED_AUDIO_BUFFERS) {
      // oxlint-disable-next-line no-await-in-loop -- The sink iterator is ordered, and priming stops at a bounded runway.
      const result = await iterator.next()

      if (!this.isCurrentPlaybackRequest(requestId)) {
        return { iterator, buffers, exhausted: true }
      }

      if (result.done) {
        exhausted = true
        break
      }

      buffers.push(result.value)

      if (
        result.value.timestamp + result.value.buffer.duration >=
        fromTime + MIN_AUDIO_PREROLL_SECONDS
      ) {
        break
      }
    }

    if (buffers.length === MAX_QUEUED_AUDIO_BUFFERS && !exhausted) {
      this.diagnostics.record({
        stage: "audio",
        event: "prime-buffer-limit",
        mediaTime: fromTime,
      })
    }

    return { iterator, buffers, exhausted }
  }

  private async prepareVideo(
    fromTime: number,
    requestId: number
  ): Promise<PreparedVideo> {
    const track = this.videoTrack

    if (track === null) {
      return {
        iterator: null,
        firstFrame: null,
        gap: false,
      }
    }

    const sink = await this.dependencies.createCanvasSink(
      track,
      CANVAS_POOL_SIZE,
      true
    )

    if (!this.isCurrentPlaybackRequest(requestId)) {
      return {
        iterator: null,
        firstFrame: null,
        gap: false,
      }
    }

    const iterator = sink.canvases(
      Math.max(0, fromTime - VIDEO_LOOKAHEAD_SECONDS)
    )

    this.canvasIterator = iterator

    return this.readPreparedVideoFrame(iterator, fromTime, requestId)
  }

  private async readPreparedVideoFrame(
    iterator: AsyncGenerator<WrappedCanvas>,
    fromTime: number,
    requestId: number
  ): Promise<PreparedVideo> {
    while (true) {
      // A frame remains valid over its presentation interval, not just from its timestamp.
      // oxlint-disable-next-line no-await-in-loop
      const result = await iterator.next()

      if (!this.isCurrentPlaybackRequest(requestId)) {
        return { iterator, firstFrame: null, gap: false }
      }

      if (result.done) {
        throw new Error(
          "The video track ended before a frame covered the requested playback time"
        )
      }

      const readiness = classifyVideoFrame(
        result.value,
        fromTime,
        this.durationValue
      )

      switch (readiness.kind) {
        case "invalid": {
          throw new Error("The video track returned an invalid frame interval")
        }

        case "expired": {
          continue
        }

        case "after-end": {
          throw new Error(
            "The video track has no frame before the end of the media"
          )
        }

        case "covering":
        case "gap": {
          // A future frame confirms a real presentation gap. Keep it queued so
          // the renderer waits until its timestamp instead of showing it early.
          return {
            iterator,
            firstFrame: readiness.frame,
            gap: readiness.kind === "gap",
          }
        }
      }
    }
  }

  private isCurrentPlaybackRequest(requestId: number): boolean {
    return (
      !this.disposed &&
      (this.playPending || this.pausedPreparationActive) &&
      requestId === this.playbackRequestId
    )
  }

  private createPlaybackCancellation(requestId: number): PlaybackCancellation {
    const signal = createCancellationSignal()
    const cancellation = { requestId, ...signal }

    this.playbackCancellation = cancellation

    return cancellation
  }

  private clearPlaybackCancellation(requestId: number): void {
    if (this.playbackCancellation?.requestId === requestId) {
      this.playbackCancellation = null
    }
  }

  private cancelPendingPlayback(): void {
    const cancellation = this.playbackCancellation

    this.playbackCancellation = null
    cancellation?.cancel()
  }

  private clearPausedPreparation(stopIterators: boolean): void {
    const hasPreparedWork =
      this.pausedPreparationActive || this.pausedPreparedPlayback !== null

    this.pausedPreparationActive = false
    this.pausedPreparationRequestId = 0
    this.pausedPreparationPromise = null
    this.pausedPreparedPlayback = null

    if (stopIterators && hasPreparedWork) {
      this.stopPlayback()
    }
  }

  // A run failure that escapes to here is real (mediabunny retries transient
  // fetches internally); surfacing it beats the old behavior, where the
  // audio feed died silently while the clock and video continued.
  private async runAudioTask(
    task: Promise<void>,
    generation: number,
    audioGeneration: number
  ): Promise<void> {
    try {
      await task
    } catch (error) {
      if (
        this.disposed ||
        generation !== this.generation ||
        audioGeneration !== this.audioGeneration
      ) {
        // The failed run was superseded by a seek, switch, or dispose; the
        // run that replaced it owns the error surface now.
        return
      }

      this.failRunningTask(
        error instanceof Error ? error : new Error("Media playback failed."),
        "audio"
      )
    }
  }

  private async runVideoTask(
    task: Promise<void>,
    generation: number,
    videoGeneration: number
  ): Promise<void> {
    try {
      await task
    } catch (error) {
      if (
        this.disposed ||
        generation !== this.generation ||
        videoGeneration !== this.videoGeneration
      ) {
        return
      }

      this.failRunningTask(
        error instanceof Error ? error : new Error("Media playback failed."),
        "video"
      )
    }
  }

  private failRunningTask(error: Error, stage: "audio" | "video"): void {
    const code = loadErrorCode(error, this.input !== null)

    this.haltPlaybackForFailure()
    this.fail(
      error.message,
      code,
      playbackFailureFor(error, this.input !== null)
    )
    this.diagnostics.record({
      stage,
      event: "failed",
      errorCode: code,
    })
  }

  private stopPlayback(): void {
    this.stopAudio()
    this.stopVideoLoop()
  }

  private haltPlaybackForFailure(): void {
    this.frozenMediaTime = this.currentMediaTime()
    this.playing = false
    this.playPending = false
    this.buffering = false
    this.stopPlayback()
    this.notify({ type: "pause" })
  }

  private stopAudio(): void {
    this.audioGeneration += 1
    this.audioFeedExhausted = false
    this.audioRunPrimed = false
    this.lastScheduledAudioEnd = 0
    this.pendingAudioBuffers = []

    const { activeAudioNodes } = this
    this.activeAudioNodes = []

    for (const { node } of activeAudioNodes) {
      node.stop()
      node.disconnect()
    }

    const iterator = this.audioIterator

    this.audioIterator = null

    if (iterator !== null) {
      void iterator.return(undefined).catch(() => {
        // A returned iterator can reject if its input was disposed first.
      })
    }
  }

  private stopVideoLoop(): void {
    this.videoGeneration += 1
    this.frameQueue = []
    this.pullingFrame = false
    this.videoTick = null

    if (this.renderFrame !== null) {
      cancelAnimationFrame(this.renderFrame)
      this.renderFrame = null
    }

    const iterator = this.canvasIterator

    this.canvasIterator = null

    if (iterator !== null) {
      void iterator.return(undefined).catch(() => {
        // Same as above.
      })
    }
  }

  private async startAudio(
    fromTime: number,
    preparedIterator?: AsyncGenerator<WrappedAudioBuffer>
  ): Promise<void> {
    const { generation } = this
    const { audioGeneration } = this

    if (this.selectedAudioTrack === null) {
      this.finishIfAudioFeedExhausted(generation, audioGeneration)

      return
    }

    if (
      !(await this.ensureAudioSink()) ||
      !this.isCurrentAudioRun(generation, audioGeneration)
    ) {
      return
    }

    const iterator = preparedIterator ?? this.audioSink?.buffers(fromTime)

    if (iterator === undefined) {
      return
    }

    this.audioIterator = iterator
    this.audioFeedExhausted = false
    await this.consumeAudio(iterator, { generation, audioGeneration })
  }

  private async consumeAudio(
    iterator: AsyncGenerator<WrappedAudioBuffer>,
    run: AudioRunToken
  ): Promise<void> {
    try {
      for await (const wrapped of iterator) {
        if (!this.isCurrentAudioRun(run.generation, run.audioGeneration)) {
          return
        }

        this.scheduleAudioBuffer(wrapped.buffer, wrapped.timestamp)

        if (
          !(await this.waitForAudioCapacity(
            run.generation,
            run.audioGeneration
          ))
        ) {
          return
        }
      }

      this.finishIfAudioFeedExhausted(run.generation, run.audioGeneration)
    } finally {
      if (this.audioIterator === iterator) {
        this.audioIterator = null
      }
    }
  }

  private isCurrentAudioRun(
    generation: number,
    audioGeneration: number
  ): boolean {
    return (
      !this.disposed &&
      generation === this.generation &&
      audioGeneration === this.audioGeneration &&
      this.playing
    )
  }

  private async waitForAudioCapacity(
    generation: number,
    audioGeneration: number
  ): Promise<boolean> {
    if (this.activeAudioNodes.length < MAX_QUEUED_AUDIO_BUFFERS) {
      return true
    }

    const [oldest] = this.activeAudioNodes

    if (oldest !== undefined) {
      await oldest.ended
    }

    return this.isCurrentAudioRun(generation, audioGeneration)
  }

  private async ensureAudioSink(): Promise<boolean> {
    const track = this.selectedAudioTrack
    const { generation } = this

    if (
      track === null ||
      this.audioContext === null ||
      this.masterGain === null
    ) {
      return false
    }

    if (this.audioSink === null) {
      this.audioSink = await this.dependencies.createAudioSink(track)
    }

    return !this.disposed && generation === this.generation
  }

  private finishIfAudioFeedExhausted(
    generation: number,
    audioGeneration: number
  ): void {
    if (!this.isCurrentAudioRun(generation, audioGeneration)) {
      return
    }

    this.audioFeedExhausted = true

    if (this.buffering) {
      this.resumeAudioBuffering(true)
    }

    this.finishIfPlaybackTimeReachedEnd(this.currentMediaTime())
  }

  private finishIfPlaybackTimeReachedEnd(currentTime: number): boolean {
    if (
      this.disposed ||
      !this.playing ||
      !this.audioFeedExhausted ||
      currentTime < this.durationValue
    ) {
      return false
    }

    this.frozenMediaTime = this.durationValue
    this.playing = false
    this.endedFlag = true
    this.stopPlayback()
    this.notify({ type: "timeupdate", currentTime: this.durationValue })
    this.notify({ type: "pause" })
    this.notify({ type: "ended" })

    return true
  }

  private scheduleAudioBuffer(buffer: AudioBuffer, timestamp: number): void {
    const context = this.audioContext
    const gain = this.masterGain

    if (context === null || gain === null) {
      return
    }

    if (this.hasAudioRunUnderrun(context)) {
      this.enterAudioBuffering()
    }

    if (this.buffering) {
      this.pendingAudioBuffers.push({ buffer, timestamp })

      if (
        this.pendingAudioBuffers.length >= MAX_QUEUED_AUDIO_BUFFERS ||
        this.audioCoverageEnd() >=
          this.frozenMediaTime + MIN_AUDIO_PREROLL_SECONDS
      ) {
        this.resumeAudioBuffering(false)
      }

      return
    }

    const schedule = this.calculateAudioBufferSchedule(
      buffer,
      timestamp,
      context
    )

    if (schedule === null) {
      return
    }

    this.recordAudioBufferTrim(timestamp, schedule.sourceOffset)
    this.scheduleAudioNode({ buffer, timestamp, gain, ...schedule })
  }

  private audioCoverageEnd(): number {
    let coveredUntil = this.frozenMediaTime

    for (const wrapped of this.pendingAudioBuffers) {
      const bufferEnd = wrapped.timestamp + wrapped.buffer.duration
      const startsBeforeGap = wrapped.timestamp <= coveredUntil + 0.05

      if (startsBeforeGap && bufferEnd > coveredUntil) {
        coveredUntil = bufferEnd
      }
    }

    return coveredUntil
  }

  private resumeAudioBuffering(force: boolean): void {
    if (!this.buffering || (!force && this.pendingAudioBuffers.length === 0)) {
      return
    }

    const buffers = this.pendingAudioBuffers
    this.pendingAudioBuffers = []
    this.buffering = false
    this.lastScheduledAudioEnd = 0
    this.reanchor(this.frozenMediaTime)

    for (const wrapped of buffers) {
      this.scheduleAudioBuffer(wrapped.buffer, wrapped.timestamp)
    }

    this.diagnostics.record({
      stage: "audio",
      event: "underrun-recovered",
      mediaTime: this.frozenMediaTime,
    })
    this.notify({ type: "playing" })

    if (this.videoTick !== null && this.renderFrame === null) {
      this.renderFrame = requestAnimationFrame(this.videoTick)
    }
  }

  private enterAudioBuffering(): void {
    const context = this.audioContext

    if (context === null || this.buffering) {
      return
    }

    const currentTime = this.currentMediaTime()

    const audioEndTime =
      this.lastScheduledAudioEnd > 0
        ? this.anchorMediaTime +
          (this.lastScheduledAudioEnd - this.anchorContextTime) * this.rateValue
        : currentTime

    this.frozenMediaTime = Math.max(0, Math.min(currentTime, audioEndTime))
    this.buffering = true
    this.lastScheduledAudioEnd = 0
    this.reanchor(this.frozenMediaTime)

    if (this.renderFrame !== null) {
      cancelAnimationFrame(this.renderFrame)
      this.renderFrame = null
    }

    this.diagnostics.record({
      stage: "audio",
      event: "underrun",
      mediaTime: this.frozenMediaTime,
    })
    this.notify({ type: "timeupdate", currentTime: this.frozenMediaTime })
    this.notify({ type: "waiting" })
  }

  private hasAudioRunUnderrun(context: AudioContext): boolean {
    return (
      this.playing &&
      !this.buffering &&
      this.selectedAudioTrack !== null &&
      !this.audioFeedExhausted &&
      this.audioRunPrimed &&
      this.lastScheduledAudioEnd > 0 &&
      this.lastScheduledAudioEnd <= context.currentTime
    )
  }

  private calculateAudioBufferSchedule(
    buffer: AudioBuffer,
    timestamp: number,
    context: AudioContext
  ): AudioBufferSchedule | null {
    const when =
      this.anchorContextTime +
      (timestamp - this.anchorMediaTime) / this.rateValue

    // Wholly stale buffers (an interruption longer than this buffer)
    // are dropped, not clamped: playing them now would be a garbled burst.
    if (when + buffer.duration / this.rateValue <= context.currentTime) {
      return null
    }

    const startAt = Math.max(
      when,
      context.currentTime,
      this.lastScheduledAudioEnd
    )

    const sourceOffset = Math.max(0, (startAt - when) * this.rateValue)

    if (sourceOffset >= buffer.duration) {
      return null
    }

    return { startAt, sourceOffset }
  }

  private recordAudioBufferTrim(timestamp: number, sourceOffset: number): void {
    if (sourceOffset > 0) {
      this.diagnostics.record({
        stage: "audio",
        event: "buffer-trimmed",
        mediaTime: timestamp + sourceOffset,
        playbackRate: this.rateValue,
      })
    }
  }

  private scheduleAudioNode({
    buffer,
    timestamp,
    gain,
    startAt,
    sourceOffset,
  }: AudioNodeSchedule): void {
    const context = this.audioContext

    if (context === null) {
      return
    }

    const node = context.createBufferSource()
    node.buffer = buffer
    node.playbackRate.value = this.rateValue
    node.connect(gain)

    this.lastScheduledAudioEnd =
      startAt + (buffer.duration - sourceOffset) / this.rateValue

    this.activeAudioNodes.push({
      node,
      ended: this.trackAudioNodeEnd(node),
      buffer,
      timestamp,
    })

    if (sourceOffset > 0) {
      node.start(startAt, sourceOffset)
    } else {
      node.start(startAt)
    }
  }

  private rescheduleAudioQueue(): void {
    const queuedBuffers = this.activeAudioNodes.map(
      ({ buffer, timestamp }) => ({
        buffer,
        timestamp,
      })
    )

    const oldNodes = this.activeAudioNodes
    this.activeAudioNodes = []
    this.lastScheduledAudioEnd = 0

    for (const { node } of oldNodes) {
      node.stop()
      node.disconnect()
    }

    for (const { buffer, timestamp } of queuedBuffers) {
      this.scheduleAudioBuffer(buffer, timestamp)
    }
  }

  // Resolves when the node finishes and removes it from the capacity ledger.
  private trackAudioNodeEnd(node: AudioBufferSourceNode): Promise<void> {
    return new Promise<void>((resolve) => {
      node.addEventListener(
        "ended",
        () => {
          this.activeAudioNodes = this.activeAudioNodes.filter(
            (active) => active.node !== node
          )
          resolve()
        },
        { once: true }
      )
    })
  }

  private async startVideoLoop(prepared: PreparedVideo): Promise<void> {
    const track = this.videoTrack
    const { generation } = this
    const { videoGeneration } = this

    if (track !== null && prepared.iterator !== null) {
      this.canvasIterator = prepared.iterator
      this.lastBlittedTimestamp = -1

      if (prepared.firstFrame !== null) {
        this.frameQueue.push({
          canvas: prepared.firstFrame.canvas,
          timestamp: prepared.firstFrame.timestamp,
        })
      }
    }

    if (
      this.disposed ||
      generation !== this.generation ||
      videoGeneration !== this.videoGeneration ||
      !this.playing
    ) {
      return
    }

    const tick = () => {
      if (
        this.disposed ||
        generation !== this.generation ||
        videoGeneration !== this.videoGeneration ||
        !this.playing
      ) {
        return
      }

      const now = Math.min(this.currentMediaTime(), this.durationValue)

      if (
        this.audioContext !== null &&
        this.hasAudioRunUnderrun(this.audioContext)
      ) {
        this.enterAudioBuffering()

        return
      }

      if (this.buffering) {
        return
      }

      if (this.finishIfPlaybackTimeReachedEnd(now)) {
        return
      }

      if (track !== null) {
        this.blitDueFrames(now)
        void this.pullFramesUpTo(now + VIDEO_LOOKAHEAD_SECONDS, videoGeneration)
      }

      this.emitTimeupdate(now)
      this.renderFrame = requestAnimationFrame(tick)
    }

    this.videoTick = tick
    this.blitDueFrames(this.currentMediaTime())
    this.renderFrame = requestAnimationFrame(tick)
  }

  private blitDueFrames(now: number): void {
    while (this.frameQueue.length > 0) {
      const [head] = this.frameQueue

      if (head.timestamp > now) {
        return
      }

      this.blit(head.canvas)
      this.lastBlittedTimestamp = head.timestamp
      this.frameQueue.shift()
    }
  }

  private async pullFramesUpTo(
    horizon: number,
    videoGeneration: number
  ): Promise<void> {
    if (this.pullingFrame || this.canvasIterator === null) {
      return
    }

    const last = this.frameQueue.at(-1)

    const lastTimestamp =
      last === undefined ? this.lastBlittedTimestamp : last.timestamp

    if (lastTimestamp >= horizon) {
      return
    }

    this.pullingFrame = true
    const { generation } = this
    const iterator = this.canvasIterator

    let result: IteratorResult<WrappedCanvas> | null = null

    try {
      result = await iterator.next()
    } catch (error) {
      if (videoGeneration === this.videoGeneration) {
        this.pullingFrame = false
      }

      if (
        !this.disposed &&
        generation === this.generation &&
        videoGeneration === this.videoGeneration
      ) {
        this.failRunningTask(
          error instanceof Error ? error : new Error("Media playback failed."),
          "video"
        )
      }

      return
    }

    if (videoGeneration === this.videoGeneration) {
      this.pullingFrame = false
      this.acceptPulledFrame(result, iterator, videoGeneration)
    }
  }

  private acceptPulledFrame(
    result: IteratorResult<WrappedCanvas>,
    iterator: AsyncGenerator<WrappedCanvas>,
    videoGeneration: number
  ): void {
    if (
      result.done ||
      this.disposed ||
      videoGeneration !== this.videoGeneration ||
      this.canvasIterator !== iterator
    ) {
      return
    }

    const { canvas } = result.value

    this.recordDecodedFrame(result.value)
    this.frameQueue.push({ canvas, timestamp: result.value.timestamp })
  }

  private recordDecodedFrame(frame: WrappedCanvas): void {
    const decodedThrough = frame.timestamp + frame.duration

    if (!Number.isFinite(decodedThrough) || decodedThrough < frame.timestamp) {
      return
    }

    this.decodedVideoThroughValue = Math.max(
      this.decodedVideoThroughValue ?? 0,
      decodedThrough
    )
  }

  private blit(canvas: HTMLCanvasElement | OffscreenCanvas): void {
    const target = this.displayCanvas

    if (target === null) {
      return
    }

    if (target.width !== canvas.width || target.height !== canvas.height) {
      target.width = canvas.width
      target.height = canvas.height
    }

    target.getContext("2d")?.drawImage(canvas, 0, 0)
  }

  private emitTimeupdate(now: number): void {
    const timestamp = performance.now()

    if (timestamp - this.lastTimeupdateAt >= TIMEUPDATE_INTERVAL_MS) {
      this.lastTimeupdateAt = timestamp
      this.notify({ type: "timeupdate", currentTime: now })
    }
  }

  private fail(message: string, code: number, failure?: PlaybackFailure): void {
    this.dispose()
    this.notify(
      failure === undefined
        ? { type: "error", code, message }
        : { type: "error", code, message, failure }
    )
  }
}
