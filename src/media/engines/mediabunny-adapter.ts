// Video.js media adapter around the Mediabunny engine. Implements the media
// surface the player store probes (play/pause/seek/volume/rate/errors) and
// translates engine state events into standard media events. Registered as
// the player's media via useMediaAttach, so the skin works over it unchanged.
import type { EngineStateEvent, MediabunnyEngine } from "./mediabunny-engine"

const HAVE_NOTHING = 0

const HAVE_METADATA = 1

const HAVE_ENOUGH_DATA = 4

interface StaticTimeRanges {
  readonly length: number
  start(index: number): number
  end(index: number): number
}

const EMPTY_TIME_RANGES: StaticTimeRanges = {
  length: 0,
  start: () => 0,
  end: () => 0,
}

export class MediabunnyMediaAdapter extends EventTarget {
  private readyStateValue: number = HAVE_NOTHING
  private errorValue: { code: number; message: string } | null = null
  private readonly textTrackHost = document.createElement("video")

  constructor(
    private readonly engine: MediabunnyEngine,
    private readonly sourceUrl: string
  ) {
    super()

    engine.listen(this.onEngineEvent)
  }

  private onEngineEvent = (event: EngineStateEvent): void => {
    switch (event.type) {
      case "loaded":
        this.readyStateValue = HAVE_METADATA
        this.dispatch("loadedmetadata")
        this.dispatch("durationchange")
        this.dispatch("loadeddata")
        break
      case "waiting":
        this.readyStateValue = HAVE_METADATA
        this.dispatch("waiting")
        break
      case "playing":
        this.readyStateValue = HAVE_ENOUGH_DATA
        this.dispatch("canplay")
        this.dispatch("playing")
        break
      case "timeupdate":
      case "seeking":
      case "seeked":
      case "play":
      case "pause":
      case "ended":
      case "volumechange":
      case "ratechange":
        this.dispatch(event.type)
        break
      case "seekfailed":
        this.dispatch("seekerror")
        this.dispatch("seeked")
        break
      case "error":
        this.errorValue = { code: event.code, message: event.message }
        this.dispatch("error")
        break
    }
  }

  private dispatch(type: string): void {
    this.dispatchEvent(new Event(type))
  }

  play(): Promise<void> {
    return this.engine.play()
  }

  pause(): void {
    this.engine.pause()
  }

  get paused(): boolean {
    return this.engine.paused
  }

  get ended(): boolean {
    return this.engine.ended
  }

  get duration(): number {
    return this.engine.duration
  }

  get seeking(): boolean {
    return this.engine.seeking
  }

  get currentTime(): number {
    return this.engine.currentTime
  }

  set currentTime(time: number) {
    void this.engine.seek(time)
  }

  get volume(): number {
    return this.engine.volume
  }

  set volume(volume: number) {
    this.engine.setVolume(volume)
  }

  get muted(): boolean {
    return this.engine.muted
  }

  set muted(muted: boolean) {
    this.engine.setMuted(muted)
  }

  get defaultMuted(): boolean {
    return false
  }

  get playbackRate(): number {
    return this.engine.playbackRate
  }

  set playbackRate(rate: number) {
    this.engine.setPlaybackRate(rate)
  }

  get defaultPlaybackRate(): number {
    return 1
  }

  get src(): string {
    return this.sourceUrl
  }

  get currentSrc(): string {
    return this.sourceUrl
  }

  get textTracks(): TextTrackList {
    return this.textTrackHost.textTracks
  }

  addSubtitleTrack(label: string, language: string): TextTrack {
    return this.textTrackHost.addTextTrack("subtitles", label, language)
  }

  get readyState(): number {
    return this.readyStateValue
  }

  get error(): { code: number; message: string } | null {
    return this.errorValue
  }

  get buffered(): StaticTimeRanges {
    return EMPTY_TIME_RANGES
  }

  get played(): StaticTimeRanges {
    return EMPTY_TIME_RANGES
  }

  get videoWidth(): number {
    return this.engine.width ?? 0
  }

  get videoHeight(): number {
    return this.engine.height ?? 0
  }

  get loop(): boolean {
    return false
  }

  get controls(): boolean {
    return false
  }

  get autoplay(): boolean {
    return false
  }

  load(): void {}

  canPlayType(): string {
    return ""
  }
}
