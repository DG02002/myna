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

import type { PlaybackSource } from "../models/source"
import { proxiedMediaUrl } from "../proxy/proxied-url"

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
  | { type: "seeking" }
  | { type: "seeked"; currentTime: number }
  | { type: "play" }
  | { type: "playing" }
  | { type: "pause" }
  | { type: "ended" }
  | { type: "volumechange" }
  | { type: "ratechange" }
  | { type: "error"; code: number; message: string }

// Kept near two frames: the canvas pool is a ring buffer, so queueing more
// frames than the pool lets later decodes overwrite queued canvases.
const VIDEO_LOOKAHEAD_SECONDS = 0.1

const CANVAS_POOL_SIZE = 4

const MAX_QUEUED_AUDIO_BUFFERS = 32

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
}

async function createInputFor(
  source: PlaybackSource,
  attachInput: (input: Input) => void
): Promise<{ input: Input; readMode: "direct" | "proxy" }> {
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

  const direct = new Input({
    formats,
    source: new UrlSource(source.url),
  })

  attachInput(direct)

  try {
    await direct.getFormat()

    return { input: direct, readMode: "direct" }
  } catch {
    direct.dispose()

    // Mirrors the probe: signed-link origins serve no CORS headers, so byte
    // reads for this source class go through the same-origin proxy.
    const proxied = new Input({
      formats,
      source: new UrlSource(proxiedMediaUrl(source.url)),
    })

    attachInput(proxied)

    try {
      await proxied.getFormat()

      return { input: proxied, readMode: "proxy" }
    } catch (error) {
      proxied.dispose()

      throw error
    }
  }
}

// Registers the focused WASM decoder only when the selected audio track
// needs it, so AAC/Opus playback never downloads the WASM bundle.
async function ensureAudioDecoderRegistered(
  track: InputAudioTrack
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
  private readonly listeners: ((event: EngineStateEvent) => void)[] = []

  private disposed = false
  private generation = 0
  private audioGeneration = 0

  private input: Input | null = null
  private audioContext: AudioContext | null = null
  private masterGain: GainNode | null = null

  private videoTrack: InputVideoTrack | null = null
  private audioTracks: InputAudioTrack[] = []
  private selectedAudioTrack: InputAudioTrack | null = null

  private canvasSink: CanvasSink | null = null
  private canvasIterator: AsyncGenerator<WrappedCanvas> | null = null
  private audioSink: AudioBufferSink | null = null
  private audioIterator: AsyncGenerator<WrappedAudioBuffer> | null = null

  private displayCanvas: HTMLCanvasElement | null = null
  private frameQueue: { canvas: HTMLCanvasElement; timestamp: number }[] = []
  private lastBlittedTimestamp = -1
  private pullingFrame = false

  private anchorContextTime = 0
  private anchorMediaTime = 0
  private frozenMediaTime = 0
  private playing = false
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
  private renderFrame: number | null = null
  private lastTimeupdateAt = 0
  private tracksValue: EngineTrack[] = []

  constructor(init: EngineInit) {
    this.init = init
    this.frozenMediaTime = init.startTime
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

      if (this.init.autoPlay) {
        await this.play()
      }
    } catch (error) {
      if (this.disposed) {
        return
      }

      let code = this.input === null ? MEDIA_ERR_NETWORK : MEDIA_ERR_DECODE

      if (
        error instanceof NoPlayableTracksError ||
        (error instanceof Error && error.name === "UnsupportedInputFormatError")
      ) {
        code = MEDIA_ERR_SRC_NOT_SUPPORTED
      }

      this.fail(error instanceof Error ? error.message : String(error), code)
    }
  }

  private async openInput(): Promise<void> {
    const { input } = await createInputFor(this.init.source, (nextInput) => {
      this.input = nextInput

      if (this.disposed) {
        nextInput.dispose()
      }
    })

    if (this.disposed) {
      input.dispose()

      return
    }

    this.input = input
  }

  private createAudioContext(): void {
    this.audioContext = new AudioContext()
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

  trackId(track: InputAudioTrack | InputVideoTrack): string {
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
    return !this.playing
  }

  get ended(): boolean {
    return this.endedFlag
  }

  get currentTime(): number {
    if (!this.playing || this.audioContext === null) {
      return this.frozenMediaTime
    }

    return Math.min(this.currentMediaTime(), this.durationValue)
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

  get seeking(): boolean {
    return this.seekingFlag
  }

  async play(): Promise<void> {
    if (this.disposed || this.playing || this.input === null) {
      return
    }

    if (this.audioContext === null || this.masterGain === null) {
      return
    }

    this.endedFlag = false

    if (this.audioContext.state === "suspended") {
      await this.audioContext.resume().catch(() => {
        // Autoplay policy: the context needs a user gesture. Stay paused
        // with a frame on screen; the skin's play button starts playback.
      })
    }

    if (this.audioContext.state !== "running") {
      void this.blitFrameAt(this.frozenMediaTime)

      return
    }

    this.playing = true
    this.startPlayback(this.frozenMediaTime)
    this.notify({ type: "play" })
    this.notify({ type: "playing" })
  }

  pause(): void {
    if (!this.playing) {
      return
    }

    this.frozenMediaTime = this.currentMediaTime()
    this.playing = false
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
      this.notify({ type: "ratechange" })

      return
    }

    this.frozenMediaTime = this.currentMediaTime()
    this.rateValue = rate
    this.reanchor(this.frozenMediaTime)
    this.notify({ type: "ratechange" })
  }

  async seek(time: number): Promise<void> {
    const clamped = Math.max(0, Math.min(time, this.durationValue))

    this.seekingFlag = true
    this.notify({ type: "seeking" })

    const wasPlaying = this.playing

    if (wasPlaying) {
      this.playing = false
      this.stopPlayback()
    }

    this.frozenMediaTime = clamped
    this.endedFlag = false

    if (wasPlaying && this.audioContext !== null) {
      if (this.audioContext.state === "suspended") {
        await this.audioContext.resume()
      }

      this.playing = true
      this.startPlayback(clamped)
    } else {
      await this.blitFrameAt(clamped)
    }

    this.seekingFlag = false
    this.notify({ type: "seeked", currentTime: clamped })
  }

  // One-shot frame decode so seeking while paused still moves the picture.
  private async blitFrameAt(time: number): Promise<void> {
    const track = this.videoTrack
    const { generation } = this

    if (track === null || this.displayCanvas === null) {
      return
    }

    const { CanvasSink } = await import("mediabunny")

    if (this.disposed || generation !== this.generation) {
      return
    }

    const sink = new CanvasSink(track, { poolSize: 1 })

    const wrapped = await sink.getCanvas(time).catch(() => null)

    if (this.disposed || generation !== this.generation) {
      return
    }

    if (wrapped !== null && wrapped.canvas instanceof HTMLCanvasElement) {
      this.lastBlittedTimestamp = wrapped.timestamp
      this.blit(wrapped.canvas)
    }
  }

  // Switches the audio track without moving the playback position: stops
  // queued audio nodes and the audio iterator, then restarts the iterator
  // from the frozen time on the new track.
  async selectAudioTrack(trackId: string): Promise<void> {
    const track = this.audioTracks.find(
      (candidate) => this.trackId(candidate) === trackId
    )

    if (track === undefined || track === this.selectedAudioTrack) {
      return
    }

    await ensureAudioDecoderRegistered(track)

    const wasPlaying = this.playing

    if (wasPlaying) {
      this.frozenMediaTime = this.currentMediaTime()
      this.playing = false
      this.stopAudio()
    }

    this.selectedAudioTrack = track
    this.audioSink = null
    this.audioIterator = null

    if (wasPlaying && this.audioContext !== null) {
      this.playing = true
      void this.startAudio(this.frozenMediaTime)
    }
  }

  dispose(): void {
    if (this.disposed) {
      return
    }

    this.disposed = true
    this.generation += 1
    this.playing = false
    this.stopPlayback()
    this.input?.dispose()
    void this.audioContext?.close().catch(() => {
      // Closing can reject once the context is already closed; nothing to
      // release at that point.
    })
  }

  private currentMediaTime(): number {
    if (this.audioContext === null) {
      return this.frozenMediaTime
    }

    return (
      this.anchorMediaTime +
      (this.audioContext.currentTime - this.anchorContextTime) * this.rateValue
    )
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

  private startPlayback(fromTime: number): void {
    this.reanchor(fromTime)
    void this.startAudio(fromTime)
    void this.startVideoLoop()
  }

  private stopPlayback(): void {
    this.stopAudio()
    this.stopVideoLoop()
  }

  private stopAudio(): void {
    this.audioGeneration += 1
    this.audioFeedExhausted = false

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
    this.frameQueue = []
    this.pullingFrame = false

    if (this.renderFrame !== null) {
      cancelAnimationFrame(this.renderFrame)
      this.renderFrame = null
    }

    const iterator = this.canvasIterator

    this.canvasIterator = null
    this.canvasSink = null

    if (iterator !== null) {
      void iterator.return(undefined).catch(() => {
        // Same as above.
      })
    }
  }

  private async startAudio(fromTime: number): Promise<void> {
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

    const iterator = this.audioSink?.buffers(fromTime)

    if (iterator === undefined) {
      return
    }

    this.audioIterator = iterator
    this.audioFeedExhausted = false
    await this.consumeAudio(iterator, generation, audioGeneration)
  }

  private async consumeAudio(
    iterator: AsyncGenerator<WrappedAudioBuffer>,
    generation: number,
    audioGeneration: number
  ): Promise<void> {
    try {
      for await (const wrapped of iterator) {
        if (!this.isCurrentAudioRun(generation, audioGeneration)) {
          return
        }

        this.scheduleAudioBuffer(wrapped.buffer, wrapped.timestamp)

        if (!(await this.waitForAudioCapacity(generation, audioGeneration))) {
          return
        }
      }

      this.finishIfAudioFeedExhausted(generation, audioGeneration)
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
      const { AudioBufferSink: Sink } = await import("mediabunny")

      this.audioSink = new Sink(track)
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

    const node = context.createBufferSource()
    node.buffer = buffer
    node.playbackRate.value = this.rateValue
    node.connect(gain)

    const when =
      this.anchorContextTime +
      (timestamp - this.anchorMediaTime) / this.rateValue

    const ended = new Promise<void>((resolve) => {
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

    this.activeAudioNodes.push({ node, ended })
    node.start(Math.max(context.currentTime, when))
  }

  private async startVideoLoop(): Promise<void> {
    const track = this.videoTrack
    const { generation } = this

    if (track !== null) {
      const { CanvasSink } = await import("mediabunny")

      if (this.disposed || generation !== this.generation || !this.playing) {
        return
      }

      this.canvasSink = new CanvasSink(track, {
        poolSize: CANVAS_POOL_SIZE,
        decoderOptions: { hardwareAcceleration: "prefer-hardware" },
      })

      this.canvasIterator = this.canvasSink.canvases(
        this.currentMediaTime() - VIDEO_LOOKAHEAD_SECONDS
      )
      this.lastBlittedTimestamp = -1
    }

    if (this.disposed || generation !== this.generation || !this.playing) {
      return
    }

    const tick = () => {
      if (this.disposed || generation !== this.generation || !this.playing) {
        return
      }

      const now = Math.min(this.currentMediaTime(), this.durationValue)

      if (this.finishIfPlaybackTimeReachedEnd(now)) {
        return
      }

      if (track !== null) {
        this.blitDueFrames(now)
        void this.pullFramesUpTo(now + VIDEO_LOOKAHEAD_SECONDS)
      }

      this.emitTimeupdate(now)
      this.renderFrame = requestAnimationFrame(tick)
    }

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

  private async pullFramesUpTo(horizon: number): Promise<void> {
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
    const result = await iterator.next().catch(() => null)
    this.pullingFrame = false

    if (
      result === null ||
      result.done ||
      this.disposed ||
      generation !== this.generation ||
      this.canvasIterator !== iterator
    ) {
      return
    }

    const { canvas } = result.value

    if (canvas instanceof HTMLCanvasElement) {
      this.frameQueue.push({ canvas, timestamp: result.value.timestamp })
    }
  }

  private blit(canvas: HTMLCanvasElement): void {
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

  private fail(message: string, code: number): void {
    this.dispose()
    this.notify({ type: "error", code, message })
  }
}
