import type { HlsJsAdapter } from "@videojs/hlsjs-video"
import type { HlsJsVideo } from "@videojs/react/media/hlsjs-video"
import { VideoPlayer, Video } from "@videojs/react/video"
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
  type ReactNode,
} from "react"

import { AssSubtitleOverlay } from "#/components/player/ass-subtitle-overlay"
import {
  AudioTracksContext,
  type AudioTracksValue,
} from "#/components/player/audio-tracks-context"
import { MediabunnyVideo } from "#/components/player/mediabunny-video"
import { PgsSubtitleOverlay } from "#/components/player/pgs-subtitle-overlay"
import { SubtitlePlaybackStatus } from "#/components/player/subtitle-controls"
import { SubtitleOverlay } from "#/components/player/subtitle-overlay"
import { useSubtitles } from "#/components/player/subtitle-tracks"
import { SubtitleTracksContext } from "#/components/player/subtitle-tracks-context"
import { Button } from "#/components/ui/button"
import { VideoSkin } from "#/components/videojs/video/skin"
import type { MediabunnyMediaAdapter } from "#/media/engines/mediabunny-adapter"
import {
  MediabunnyEngine,
  type EngineInit,
} from "#/media/engines/mediabunny-engine"
import { ConfirmedPosition } from "#/media/models/confirmed-position"
import { MEDIA_ERR_SRC_NOT_SUPPORTED } from "#/media/models/media-errors"
import {
  canPersistPlaybackPosition,
  createResumeConfirmation,
  RESUME_CONFIRMATION_DEADLINE_MS,
  RESUME_POSITION_TOLERANCE_SECONDS,
  type ResumeStatus,
} from "#/media/models/playback-resume"
import {
  isHlsUrl,
  isMatroskaUrl,
  type PlaybackSource,
} from "#/media/models/source"
import { probeSource, type ProbeResult } from "#/media/probe/metadata-probe"
import { probeTrackLabel } from "#/media/probe/track-labels"
import type { SubtitleTrack } from "#/media/subtitles"

type HlsJsVideoComponent = typeof HlsJsVideo

// Apple's browsers are the one family where the plan's "native HLS" path is
// the first-class pipeline; they are identified by a capability no other
// browser exposes — the webkit presentation-mode (PiP) API on video
// elements — rather than a user-agent string. Everywhere else hls.js over
// MSE plays, which the quality menu needs (renditions exist only on the MSE
// engine) and which sidesteps Chromium's own new HLS support that still
// rejects some streams outright (measured, October 2026).
let platformHlsHint: boolean | undefined

function prefersPlatformHls(): boolean {
  platformHlsHint ??=
    typeof HTMLVideoElement !== "undefined" &&
    "webkitPresentationMode" in HTMLVideoElement.prototype

  return platformHlsHint
}

export type PlaybackEngineMode = "native" | "mediabunny"

export type ProbeState =
  | { status: "loading" }
  | { status: "ready"; result: ProbeResult }
  | { status: "failed" }

interface MigrationSnapshot {
  time: number
  wasPlaying: boolean
  volume: number
  muted: boolean
  playbackRate: number
  audioTrackId: string | null
  subtitleTrackId: string | null
}

export interface PlaybackStageDetails {
  mediaElement: HTMLVideoElement | null
  engine: MediabunnyEngine | null
  subtitleTracks: SubtitleTrack[]
  addSubtitle: (url: string) => void
  canAddSubtitles: boolean
  embeddedProbeFailed: boolean
}

export interface PlaybackPositionChange {
  currentTime: number
  reason: "progress" | "seek" | "pause" | "ended"
}

export interface PlaybackStageDependencies {
  createEngine: (init: EngineInit) => MediabunnyEngine
  probeSource: typeof probeSource
}

function createMediabunnyEngine(init: EngineInit): MediabunnyEngine {
  return new MediabunnyEngine(init)
}

type RecoveryStatus = "idle" | "pending" | "failed"

interface RecoveryOperation {
  mode: PlaybackEngineMode
  engine: MediabunnyEngine | null
  element: HTMLVideoElement | null
  deadline: ReturnType<typeof setTimeout> | null
}

function recoveryMessage(status: RecoveryStatus): string {
  if (status === "pending") {
    return "Starting from beginning…"
  }

  if (status === "failed") {
    return "Could not start from beginning."
  }

  return "Could not restore the saved position."
}

function recoveryActionLabel(status: RecoveryStatus): string {
  if (status === "pending") {
    return "Starting…"
  }

  if (status === "failed") {
    return "Try again"
  }

  return "Start from beginning"
}

interface NativePositionEventHandlers {
  restorePosition: () => void
  onTimeUpdate: () => void
  onSeeking: () => void
  onSeeked: () => void
  onPause: () => void
  onEnded: () => void
}

function listenToNativePositionEvents(
  element: HTMLVideoElement,
  handlers: NativePositionEventHandlers
): () => void {
  element.addEventListener("loadedmetadata", handlers.restorePosition)
  element.addEventListener("timeupdate", handlers.onTimeUpdate)
  element.addEventListener("seeking", handlers.onSeeking)
  element.addEventListener("seeked", handlers.onSeeked)
  element.addEventListener("pause", handlers.onPause)
  element.addEventListener("ended", handlers.onEnded)

  return () => {
    element.removeEventListener("loadedmetadata", handlers.restorePosition)
    element.removeEventListener("timeupdate", handlers.onTimeUpdate)
    element.removeEventListener("seeking", handlers.onSeeking)
    element.removeEventListener("seeked", handlers.onSeeked)
    element.removeEventListener("pause", handlers.onPause)
    element.removeEventListener("ended", handlers.onEnded)
  }
}

function migrationStartTime({
  status,
  initialTime,
  element,
  confirmedPosition,
}: {
  status: ResumeStatus
  initialTime: number
  element: HTMLVideoElement | null
  confirmedPosition: ConfirmedPosition
}): number {
  if (status === "pending" || status === "failed") {
    return initialTime
  }

  if (
    element !== null &&
    element.readyState >= HTMLMediaElement.HAVE_METADATA
  ) {
    return confirmedPosition.capture(element.currentTime, element.seeking)
  }

  return initialTime
}

function ResumeRecoveryNotice({
  visible,
  status,
  onStartFromBeginning,
}: {
  visible: boolean
  status: RecoveryStatus
  onStartFromBeginning: () => void
}) {
  if (!visible) {
    return null
  }

  return (
    <div
      role="alert"
      aria-busy={status === "pending"}
      className="absolute inset-0 z-50 grid place-items-center bg-black/70 p-4"
    >
      <div className="max-w-sm rounded-xl bg-background p-5 text-center text-foreground shadow-xl">
        <p className="mb-3 text-sm">{recoveryMessage(status)}</p>
        <Button disabled={status === "pending"} onClick={onStartFromBeginning}>
          {recoveryActionLabel(status)}
        </Button>
      </div>
    </div>
  )
}

function usePlaybackPositionTracking({
  mode,
  nativeMediaRef,
  nativeVideoElement,
  engine,
  onPositionChange,
  startTimeSeconds,
}: {
  mode: PlaybackEngineMode
  nativeMediaRef: RefObject<HTMLVideoElement | null>
  nativeVideoElement: HTMLVideoElement | null
  engine: MediabunnyEngine | null
  onPositionChange: (change: PlaybackPositionChange) => void
  startTimeSeconds: number
}) {
  const [initialStartTimeSeconds, setInitialStartTimeSeconds] =
    useState(startTimeSeconds)

  const [resumeStatus, setResumeStatus] = useState<ResumeStatus>(() =>
    startTimeSeconds > 0 ? "pending" : "idle"
  )

  const resumeStatusRef = useRef(resumeStatus)
  const nativePositionRef = useRef<ConfirmedPosition | null>(null)
  const [recoveryStatus, setRecoveryStatus] = useState<RecoveryStatus>("idle")
  const recoveryOperationRef = useRef<RecoveryOperation | null>(null)

  const [engineStartTimeSeconds, setEngineStartTimeSeconds] =
    useState(startTimeSeconds)

  const getNativePosition = useCallback(() => {
    const currentPosition = nativePositionRef.current

    if (currentPosition !== null) {
      return currentPosition
    }

    const initialPosition = new ConfirmedPosition(startTimeSeconds)
    nativePositionRef.current = initialPosition

    return initialPosition
  }, [startTimeSeconds])

  const updateResumeStatus = useCallback((status: ResumeStatus) => {
    resumeStatusRef.current = status
    setResumeStatus(status)
  }, [])

  const ownsRecovery = useCallback((operation: RecoveryOperation) => {
    return recoveryOperationRef.current === operation
  }, [])

  const failRecovery = useCallback(
    (operation: RecoveryOperation) => {
      if (!ownsRecovery(operation)) {
        return
      }

      if (operation.deadline !== null) {
        clearTimeout(operation.deadline)
        operation.deadline = null
      }

      if (operation.mode === "native") {
        getNativePosition().cancelSeek()
      }

      recoveryOperationRef.current = null
      setRecoveryStatus("failed")
    },
    [getNativePosition, ownsRecovery]
  )

  const completeRecovery = useCallback(
    (operation: RecoveryOperation, resultingTime: number) => {
      if (!ownsRecovery(operation)) {
        return
      }

      const actualTime =
        operation.mode === "native"
          ? operation.element?.currentTime
          : operation.engine?.currentTime

      if (
        actualTime === undefined ||
        !Number.isFinite(actualTime) ||
        Math.abs(actualTime) > RESUME_POSITION_TOLERANCE_SECONDS ||
        !Number.isFinite(resultingTime) ||
        Math.abs(resultingTime) > RESUME_POSITION_TOLERANCE_SECONDS
      ) {
        failRecovery(operation)

        return
      }

      if (
        operation.mode === "native" &&
        (operation.element === null ||
          !getNativePosition().completeSeek(
            actualTime,
            operation.element.seeking
          ))
      ) {
        failRecovery(operation)

        return
      }

      if (operation.deadline !== null) {
        clearTimeout(operation.deadline)
        operation.deadline = null
      }

      recoveryOperationRef.current = null
      setRecoveryStatus("idle")
      updateResumeStatus("declined")
      setInitialStartTimeSeconds(0)
      setEngineStartTimeSeconds(0)
      onPositionChange({ currentTime: actualTime, reason: "seek" })
    },
    [
      failRecovery,
      getNativePosition,
      onPositionChange,
      ownsRecovery,
      setEngineStartTimeSeconds,
      updateResumeStatus,
    ]
  )

  const cancelRecovery = useCallback(() => {
    const operation = recoveryOperationRef.current

    if (operation === null) {
      return
    }

    if (operation.deadline !== null) {
      clearTimeout(operation.deadline)
      operation.deadline = null
    }

    if (operation.mode === "native") {
      getNativePosition().cancelSeek()
    }

    recoveryOperationRef.current = null
    setRecoveryStatus("idle")
  }, [getNativePosition])

  useEffect(() => {
    if (mode !== "native" || nativeVideoElement === null) {
      return undefined
    }

    const element = nativeMediaRef.current

    if (element === null) {
      return undefined
    }

    const nativePosition = getNativePosition()

    const resume = createResumeConfirmation({
      targetTime: initialStartTimeSeconds,
      getStatus: () => resumeStatusRef.current,
      updateStatus: updateResumeStatus,
      onAccepted(currentTime, confirmed) {
        if (confirmed) {
          setInitialStartTimeSeconds(0)
        }

        onPositionChange({ currentTime, reason: "seek" })
      },
    })

    let resumeSeekStarted = false

    const restorePosition = () => {
      if (resumeStatusRef.current !== "pending" || resumeSeekStarted) {
        return
      }

      if (
        !Number.isFinite(element.duration) ||
        element.duration <= 0 ||
        initialStartTimeSeconds >= element.duration - 1
      ) {
        resume.fail()

        return
      }

      resumeSeekStarted = true
      nativePosition.beginSeek(initialStartTimeSeconds)

      try {
        element.currentTime = initialStartTimeSeconds
      } catch {
        resume.fail()

        return
      }

      resume.startDeadline()
    }

    const onTimeUpdate = () => {
      const currentTime = nativePosition.observePosition(
        element.currentTime,
        element.seeking
      )

      if (
        currentTime !== null &&
        canPersistPlaybackPosition(resumeStatusRef.current)
      ) {
        onPositionChange({
          currentTime,
          reason: "progress",
        })
      }
    }

    const onSeeking = () => {
      const recovery = recoveryOperationRef.current

      if (
        recovery?.mode === "native" &&
        recovery.element === element &&
        Math.abs(element.currentTime) > RESUME_POSITION_TOLERANCE_SECONDS
      ) {
        cancelRecovery()
        nativePosition.beginSeek(element.currentTime)

        return
      }

      nativePosition.beginSeek(element.currentTime)
    }

    const onSeeked = () => {
      const recovery = recoveryOperationRef.current

      if (recovery?.mode === "native" && recovery.element === element) {
        const actualTime = element.currentTime

        if (
          Math.abs(actualTime) > RESUME_POSITION_TOLERANCE_SECONDS ||
          !nativePosition.completeSeek(actualTime, element.seeking)
        ) {
          failRecovery(recovery)

          return
        }

        completeRecovery(recovery, actualTime)

        return
      }

      if (nativePosition.completeSeek(element.currentTime, element.seeking)) {
        resume.confirm(element.currentTime)
      }
    }

    const onPause = () => {
      if (canPersistPlaybackPosition(resumeStatusRef.current)) {
        onPositionChange({
          currentTime: nativePosition.capture(
            element.currentTime,
            element.seeking
          ),
          reason: "pause",
        })
      }
    }

    const onEnded = () => {
      nativePosition.confirmEnded(element.currentTime)

      if (canPersistPlaybackPosition(resumeStatusRef.current)) {
        onPositionChange({
          currentTime: nativePosition.confirmedTime,
          reason: "ended",
        })
      }
    }

    const removePositionListeners = listenToNativePositionEvents(element, {
      restorePosition,
      onTimeUpdate,
      onSeeking,
      onSeeked,
      onPause,
      onEnded,
    })

    if (element.readyState >= HTMLMediaElement.HAVE_METADATA) {
      restorePosition()
    }

    return () => {
      removePositionListeners()
      resume.clearDeadline()

      if (canPersistPlaybackPosition(resumeStatusRef.current)) {
        onPositionChange({
          currentTime: nativePosition.capture(
            element.currentTime,
            element.seeking
          ),
          reason: "pause",
        })
      }
    }
  }, [
    initialStartTimeSeconds,
    mode,
    nativeMediaRef,
    nativeVideoElement,
    onPositionChange,
    getNativePosition,
    cancelRecovery,
    completeRecovery,
    failRecovery,
    updateResumeStatus,
  ])

  useEffect(() => {
    if (mode !== "mediabunny" || engine === null) {
      return undefined
    }

    let resumeSeekStarted = false

    const resume = createResumeConfirmation({
      targetTime: initialStartTimeSeconds,
      getStatus: () => resumeStatusRef.current,
      updateStatus: updateResumeStatus,
      onFailed: () => engine.pause(),
      onAccepted(currentTime, confirmed) {
        if (confirmed) {
          setInitialStartTimeSeconds(0)
        }

        onPositionChange({ currentTime, reason: "seek" })
      },
    })

    const startResumeConfirmation = (loaded = false) => {
      if (resumeSeekStarted || resumeStatusRef.current !== "pending") {
        return
      }

      if (engine.duration <= 0) {
        if (loaded) {
          resume.fail()
        }

        return
      }

      resumeSeekStarted = true
      resume.startDeadline()
      void engine.seek(initialStartTimeSeconds)
    }

    const unsubscribe = engine.listen((event) => {
      if (event.type === "timeupdate") {
        if (canPersistPlaybackPosition(resumeStatusRef.current)) {
          onPositionChange({
            currentTime: event.currentTime,
            reason: "progress",
          })
        }
      } else if (event.type === "seeked") {
        resume.confirm(event.currentTime)
      } else if (event.type === "seekfailed") {
        resume.fail()
      } else if (event.type === "loaded") {
        startResumeConfirmation(true)
      } else if (event.type === "pause") {
        if (canPersistPlaybackPosition(resumeStatusRef.current)) {
          onPositionChange({ currentTime: engine.currentTime, reason: "pause" })
        }
      } else if (event.type === "ended") {
        if (canPersistPlaybackPosition(resumeStatusRef.current)) {
          onPositionChange({ currentTime: engine.currentTime, reason: "ended" })
        }
      }
    })

    startResumeConfirmation()

    return () => {
      resume.clearDeadline()

      if (
        canPersistPlaybackPosition(resumeStatusRef.current) &&
        !engine.seeking
      ) {
        onPositionChange({ currentTime: engine.currentTime, reason: "pause" })
      }

      unsubscribe()
    }
  }, [
    engine,
    initialStartTimeSeconds,
    mode,
    onPositionChange,
    updateResumeStatus,
  ])

  useEffect(() => {
    return () => {
      const operation = recoveryOperationRef.current

      if (operation === null) {
        return
      }

      if (operation.deadline !== null) {
        clearTimeout(operation.deadline)
      }

      if (operation.mode === "native") {
        nativePositionRef.current?.cancelSeek()
      }

      recoveryOperationRef.current = null
    }
  }, [])

  const startNativeRecovery = useCallback(
    (operation: RecoveryOperation) => {
      const { element } = operation

      if (
        element === null ||
        element.readyState < HTMLMediaElement.HAVE_METADATA ||
        element.error !== null ||
        !Number.isFinite(element.duration) ||
        element.duration <= 0
      ) {
        failRecovery(operation)

        return
      }

      element.pause()
      getNativePosition().beginSeek(0)

      try {
        element.currentTime = 0
      } catch {
        failRecovery(operation)
      }
    },
    [failRecovery, getNativePosition]
  )

  const startEngineRecovery = useCallback(
    (operation: RecoveryOperation) => {
      const { engine: recoveryEngine } = operation

      if (recoveryEngine === null) {
        failRecovery(operation)

        return
      }

      recoveryEngine.pause()
      void recoveryEngine
        .seek(0)
        .then((result) => {
          if (!ownsRecovery(operation)) {
            return
          }

          if (result.status !== "completed" || result.operationId === null) {
            failRecovery(operation)

            return
          }

          completeRecovery(operation, result.currentTime)
        })
        .catch(() => failRecovery(operation))
    },
    [completeRecovery, failRecovery, ownsRecovery]
  )

  const startFromBeginning = useCallback(() => {
    if (
      resumeStatusRef.current !== "failed" ||
      recoveryOperationRef.current !== null
    ) {
      return
    }

    const operation: RecoveryOperation = {
      mode,
      engine,
      element: mode === "native" ? nativeMediaRef.current : null,
      deadline: null,
    }

    recoveryOperationRef.current = operation
    setRecoveryStatus("pending")
    operation.deadline = setTimeout(
      () => failRecovery(operation),
      RESUME_CONFIRMATION_DEADLINE_MS
    )

    if (mode === "native") {
      startNativeRecovery(operation)

      return
    }

    startEngineRecovery(operation)
  }, [
    engine,
    failRecovery,
    mode,
    nativeMediaRef,
    startEngineRecovery,
    startNativeRecovery,
  ])

  return {
    initialStartTimeSeconds,
    engineStartTimeSeconds,
    getNativePosition,
    resumeStatus,
    recoveryStatus,
    startFromBeginning,
    cancelRecovery,
  }
}

// The native engine wins until it cannot do the job: a fatal native error,
// or an audio track request the browser cannot serve. Migration preserves
// position, play state, volume, mute, and rate. The stage is keyed by the
// source URL, so it mounts fresh per source.
export function PlaybackStage({
  source,
  startTimeSeconds,
  onProbe,
  onModeChange,
  onPositionChange,
  renderDetails,
  dependencies,
}: {
  source: PlaybackSource
  startTimeSeconds: number
  onProbe: (state: ProbeState) => void
  onModeChange: (mode: PlaybackEngineMode) => void
  onPositionChange: (change: PlaybackPositionChange) => void
  renderDetails?: (details: PlaybackStageDetails) => ReactNode
  dependencies?: Partial<PlaybackStageDependencies>
}) {
  const [mode, setMode] = useState<PlaybackEngineMode>("native")
  const [snapshot, setSnapshot] = useState<MigrationSnapshot | null>(null)
  const [engine, setEngine] = useState<MediabunnyEngine | null>(null)
  const [adapter, setAdapter] = useState<MediabunnyMediaAdapter | null>(null)

  const [selectedAudioTrackId, setSelectedAudioTrackId] = useState<
    string | null
  >(null)

  // The probe opens containers; a playlist is not one, and fetching it just
  // to fail would waste a round trip against a signed URL. The stage is
  // keyed by source URL, so the source kind never changes within a mount.
  const { hlsSource, probeState, matroskaUrl } = usePlaybackSource(
    source,
    dependencies?.probeSource ?? probeSource
  )

  const nativeMediaRef = useRef<HTMLVideoElement | null>(null)

  const [nativeVideoElement, setNativeVideoElement] =
    useState<HTMLVideoElement | null>(null)

  const {
    initialStartTimeSeconds,
    engineStartTimeSeconds,
    getNativePosition,
    resumeStatus,
    recoveryStatus,
    startFromBeginning,
    cancelRecovery,
  } = usePlaybackPositionTracking({
    mode,
    nativeMediaRef,
    nativeVideoElement,
    engine,
    onPositionChange,
    startTimeSeconds,
  })

  const attachNativeVideo = useCallback((element: HTMLVideoElement | null) => {
    nativeMediaRef.current = element
    setNativeVideoElement(element)
  }, [])

  const {
    tracks: subtitleTracks,
    selectedId: selectedSubtitleId,
    selectedTrack: selectedSubtitleTrack,
    addSubtitle,
    restoreSelection: restoreSubtitleSelection,
    assTrackStream,
    pgsSession,
    failSubtitle,
    markSubtitleIncomplete,
    embeddedProbeFailed,
  } = useSubtitles({
    useAdvancedEngine: mode === "mediabunny",
    nativeMediaRef,
    adapter,
    matroskaUrl,
  })

  // Native sources load after mount so startup errors reach player state.
  // HLS sources are owned by the HlsJsVideo adapter, which manages the
  // element's source itself.
  useEffect(() => {
    onProbe(probeState)

    if (mode !== "native" || hlsSource) {
      return undefined
    }

    const element = nativeVideoElement

    if (element !== null && element.src !== source.url) {
      element.setAttribute("src", source.url)
      element.load()
    }

    return undefined
  }, [hlsSource, mode, nativeVideoElement, onProbe, probeState, source.url])

  const audioTracks = useMemo(() => {
    if (probeState.status !== "ready") {
      return []
    }

    return probeState.result.tracks
      .filter((track) => track.kind === "audio")
      .map((track) => ({
        id: `${track.kind}-${track.number}`,
        label: `${probeTrackLabel(track)}${track.default ? " · Default" : ""}`,
        default: track.default,
        // canDecode reflects the browser's own decoders: an E-AC-3/AC-3
        // track reports false until the engine lazily registers its WASM
        // decoder, so a false default track still needs the engine.
        nativeDecodable: track.decodable,
      }))
  }, [probeState])

  // Native playback does not expose its selected Matroska audio track in
  // Chrome. Keep the selection unknown until the user chooses one or the
  // advanced engine reports its actual selection.
  const migrateToEngine = useCallback(
    (nextAudioTrackId: string | null, element: HTMLVideoElement | null) => {
      cancelRecovery()
      setSnapshot({
        time: migrationStartTime({
          status: resumeStatus,
          initialTime: initialStartTimeSeconds,
          element,
          confirmedPosition: getNativePosition(),
        }),
        wasPlaying: element !== null && !element.paused,
        volume: element?.volume ?? 1,
        muted: element?.muted ?? false,
        playbackRate: element?.playbackRate ?? 1,
        audioTrackId: nextAudioTrackId,
        subtitleTrackId: selectedSubtitleId,
      })
      setMode("mediabunny")
      onModeChange("mediabunny")

      if (nextAudioTrackId !== null) {
        setSelectedAudioTrackId(nextAudioTrackId)
      }
    },
    [
      getNativePosition,
      initialStartTimeSeconds,
      onModeChange,
      resumeStatus,
      selectedSubtitleId,
      cancelRecovery,
    ]
  )

  useEffect(() => {
    if (
      mode !== "native" ||
      hlsSource ||
      selectedAudioTrackId !== null ||
      probeState.status !== "ready" ||
      !probeState.result.containerName.toLowerCase().includes("matroska") ||
      audioTracks.length < 2
    ) {
      return undefined
    }

    const element = nativeVideoElement

    if (element === null) {
      return undefined
    }

    let migrationRequested = false

    const migrateToContainerDefault = () => {
      if (migrationRequested || element.paused) {
        return
      }

      const preferredTrack =
        audioTracks.find((track) => track.default) ?? audioTracks[0]

      if (preferredTrack === undefined) {
        return
      }

      migrationRequested = true
      migrateToEngine(preferredTrack.id, element)
    }

    // Browsers can ignore Matroska's default audio flag and Chrome does not
    // expose native track selection here. Use the container's marked track
    // for multitrack Matroska playback instead of leaving that choice to the
    // browser's default.
    element.addEventListener("play", migrateToContainerDefault)
    element.addEventListener("timeupdate", migrateToContainerDefault)

    return () => {
      element.removeEventListener("play", migrateToContainerDefault)
      element.removeEventListener("timeupdate", migrateToContainerDefault)
    }
  }, [
    audioTracks,
    hlsSource,
    migrateToEngine,
    mode,
    nativeVideoElement,
    probeState,
    selectedAudioTrackId,
  ])

  const selectTrack = useCallback(
    (id: string) => {
      const track = audioTracks.find((candidate) => candidate.id === id)

      if (track === undefined) {
        return
      }

      if (mode === "mediabunny") {
        if (id !== selectedAudioTrackId) {
          setSelectedAudioTrackId(id)
          void engine?.selectAudioTrack(id)
        }

        return
      }

      // The native engine exposes no audio track switching (validated on
      // Chrome), and it plays a track the browser cannot decode as silence.
      // Selecting the already-selected track is only a no-op when the
      // native engine is actually playing it; otherwise migrate at the
      // current position.
      const alreadyNativelyServed =
        id === selectedAudioTrackId && track.nativeDecodable

      if (!alreadyNativelyServed) {
        migrateToEngine(id, nativeMediaRef.current)
      }
    },
    [
      audioTracks,
      selectedAudioTrackId,
      engine,
      mode,
      migrateToEngine,
      nativeMediaRef,
    ]
  )

  const onNativeError = useCallback(() => {
    // HLS failures stay in the video.js pipeline (the error dialog handles
    // them); the mediabunny engine cannot demux playlists, so migrating a
    // playlist source there would only produce a second failure.
    if (mode !== "native" || hlsSource) {
      return
    }

    migrateToEngine(selectedAudioTrackId, nativeMediaRef.current)
  }, [selectedAudioTrackId, hlsSource, mode, migrateToEngine, nativeMediaRef])

  const engineInit = useMemo<EngineInit>(
    () => ({
      source,
      startTime: snapshot?.time ?? engineStartTimeSeconds,
      autoPlay: snapshot?.wasPlaying ?? true,
      volume: snapshot?.volume ?? 1,
      muted: snapshot?.muted ?? false,
      playbackRate: snapshot?.playbackRate ?? 1,
      audioTrackId: snapshot?.audioTrackId ?? null,
    }),
    [engineStartTimeSeconds, source, snapshot]
  )

  const contextValues = useMemo(() => {
    let selectionLabel = ""

    if (mode === "native") {
      selectionLabel = "Browser default"
    } else if (selectedAudioTrackId === null) {
      selectionLabel = "Loading…"
    }

    return {
      audio: {
        tracks: audioTracks,
        selectedId: selectedAudioTrackId,
        selectionLabel,
        selectTrack,
      } satisfies AudioTracksValue,
      subtitles: {
        tracks: subtitleTracks,
        selectedId: selectedSubtitleId,
        selectSubtitle: restoreSubtitleSelection,
      },
    }
  }, [
    audioTracks,
    selectedAudioTrackId,
    mode,
    restoreSubtitleSelection,
    selectTrack,
    selectedSubtitleId,
    subtitleTracks,
  ])

  return (
    <AudioTracksContext.Provider value={contextValues.audio}>
      <SubtitleTracksContext.Provider value={contextValues.subtitles}>
        <>
          {mode === "native" ? (
            <VideoPlayer key="native">
              <VideoSkin className="aspect-video w-full">
                <SubtitlePlaybackStatus track={selectedSubtitleTrack} />
                {hlsSource ? (
                  <LazyHlsVideo
                    sourceUrl={source.url}
                    videoRef={attachNativeVideo}
                    onError={onNativeError}
                  />
                ) : (
                  <Video
                    ref={attachNativeVideo}
                    playsInline
                    preload="metadata"
                    onError={onNativeError}
                  />
                )}
                {assTrackStream !== null &&
                selectedSubtitleTrack?.source.kind === "matroska" &&
                (selectedSubtitleTrack.source.codecId === "S_TEXT/ASS" ||
                  selectedSubtitleTrack.source.codecId === "S_TEXT/SSA") ? (
                  <AssSubtitleOverlay
                    key={selectedSubtitleTrack.id}
                    trackId={selectedSubtitleTrack.id}
                    stream={assTrackStream}
                    useAdvancedEngine={false}
                    nativeVideo={nativeVideoElement}
                    adapter={null}
                    engine={null}
                    onFailure={failSubtitle}
                  />
                ) : null}
                {pgsSession !== null &&
                selectedSubtitleTrack?.source.kind === "matroska" &&
                selectedSubtitleTrack.source.codecId === "S_HDMV/PGS" ? (
                  <PgsSubtitleOverlay
                    key={selectedSubtitleTrack.id}
                    session={pgsSession}
                    trackId={selectedSubtitleTrack.id}
                    useAdvancedEngine={false}
                    nativeVideo={nativeVideoElement}
                    adapter={null}
                    onFailure={failSubtitle}
                    onUnavailable={markSubtitleIncomplete}
                  />
                ) : null}
                <ResumeRecoveryNotice
                  visible={resumeStatus === "failed"}
                  status={recoveryStatus}
                  onStartFromBeginning={startFromBeginning}
                />
              </VideoSkin>
            </VideoPlayer>
          ) : (
            <VideoPlayer key="mediabunny">
              <VideoSkin className="aspect-video w-full">
                <SubtitlePlaybackStatus track={selectedSubtitleTrack} />
                <MediabunnyVideo
                  init={engineInit}
                  createEngine={
                    dependencies?.createEngine ?? createMediabunnyEngine
                  }
                  onEngine={setEngine}
                  onSelectedAudioTrackId={setSelectedAudioTrackId}
                  onAdapter={(nextAdapter) => {
                    if (nextAdapter !== null && snapshot !== null) {
                      restoreSubtitleSelection(snapshot.subtitleTrackId)
                    }

                    setAdapter(nextAdapter)
                  }}
                />
                {adapter !== null && engine !== null ? (
                  <SubtitleOverlay
                    adapter={adapter}
                    engine={engine}
                    track={subtitleTracks.find(
                      (track) => track.id === selectedSubtitleId
                    )}
                  />
                ) : null}
                {pgsSession !== null &&
                adapter !== null &&
                selectedSubtitleTrack?.source.kind === "matroska" &&
                selectedSubtitleTrack.source.codecId === "S_HDMV/PGS" ? (
                  <PgsSubtitleOverlay
                    key={selectedSubtitleTrack.id}
                    session={pgsSession}
                    trackId={selectedSubtitleTrack.id}
                    useAdvancedEngine
                    nativeVideo={null}
                    adapter={adapter}
                    onFailure={failSubtitle}
                    onUnavailable={markSubtitleIncomplete}
                  />
                ) : null}
                {assTrackStream !== null &&
                selectedSubtitleTrack?.source.kind === "matroska" &&
                (selectedSubtitleTrack.source.codecId === "S_TEXT/ASS" ||
                  selectedSubtitleTrack.source.codecId === "S_TEXT/SSA") ? (
                  <AssSubtitleOverlay
                    key={selectedSubtitleTrack.id}
                    trackId={selectedSubtitleTrack.id}
                    stream={assTrackStream}
                    useAdvancedEngine
                    nativeVideo={null}
                    adapter={adapter}
                    engine={engine}
                    onFailure={failSubtitle}
                  />
                ) : null}
                <ResumeRecoveryNotice
                  visible={resumeStatus === "failed"}
                  status={recoveryStatus}
                  onStartFromBeginning={startFromBeginning}
                />
              </VideoSkin>
            </VideoPlayer>
          )}
          {renderDetails?.({
            mediaElement: nativeVideoElement,
            engine,
            subtitleTracks,
            addSubtitle,
            canAddSubtitles: !hlsSource,
            embeddedProbeFailed,
          })}
        </>
      </SubtitleTracksContext.Provider>
    </AudioTracksContext.Provider>
  )
}

function usePlaybackSource(
  source: PlaybackSource,
  sourceProbe: typeof probeSource
) {
  const hlsSource = isHlsUrl(source.url)
  const probeState = useSourceProbe(source, hlsSource, sourceProbe)
  const matroskaUrl = findMatroskaUrl(source.url, hlsSource, probeState)

  return { hlsSource, probeState, matroskaUrl }
}

function useSourceProbe(
  source: PlaybackSource,
  hlsSource: boolean,
  sourceProbe: typeof probeSource
): ProbeState {
  const [probeState, setProbeState] = useState<ProbeState>(() =>
    hlsSource ? { status: "failed" } : { status: "loading" }
  )

  useEffect(() => {
    if (hlsSource) {
      return undefined
    }

    const controller = new AbortController()

    sourceProbe(source, controller.signal)
      .then((result) => {
        setProbeState({ status: "ready", result })
      })
      .catch(() => {
        // Probe failures are informational only; playback is unaffected.
        if (!controller.signal.aborted) {
          setProbeState({ status: "failed" })
        }
      })

    return () => controller.abort()
  }, [source, hlsSource, sourceProbe])

  return probeState
}

function findMatroskaUrl(
  url: string,
  hlsSource: boolean,
  probeState: ProbeState
): string | null {
  if (hlsSource || isMatroskaUrl(url)) {
    return hlsSource ? null : url
  }

  if (
    probeState.status === "ready" &&
    probeState.result.containerName.toLowerCase().includes("matroska")
  ) {
    return url
  }

  return null
}

// HLS media element, loaded on demand so hls.js never downloads for a
// progressive source. The component mounts first and the source is assigned
// afterwards: assigning via props during render starts loading before the
// adapter has attached its media element, and fatal manifest errors are
// dropped in that window — a dead link then spins forever instead of
// reaching the error dialog.
//
// Engine routing: Apple platforms play through their own HLS pipeline
// (prefersPlatformHls); everyone else through hls.js over MSE, which the
// quality menu needs. A manifest the platform pipeline rejects outright gets
// one rebuild through hls.js; from then on failures belong to the error
// dialog. No crossOrigin — it breaks cross-origin native playback.
function LazyHlsVideo({
  sourceUrl,
  videoRef,
  onError,
}: {
  sourceUrl: string
  videoRef: (element: HTMLVideoElement | null) => void
  onError: () => void
}) {
  const [videoComponent, setVideoComponent] =
    useState<HlsJsVideoComponent | null>(null)

  const [platformHlsRejected, setPlatformHlsRejected] = useState(false)

  const adapterRef = useRef<HlsJsAdapter | null>(null)

  useEffect(() => {
    let cancelled = false

    void import("@videojs/react/media/hlsjs-video").then((module) => {
      if (!cancelled) {
        setVideoComponent(() => module.HlsJsVideo)
      }
    })

    return () => {
      cancelled = true
    }
  }, [])

  // Runs after the video component below has mounted and its adapter has
  // attached, so loading starts against an attached element.
  useEffect(() => {
    const adapter = adapterRef.current

    if (videoComponent === null || adapter === null) {
      return undefined
    }

    const usePlatformHls = prefersPlatformHls() && !platformHlsRejected

    // The adapter re-dispatches the element's error events on itself (the
    // element's own are stopped at the element), which is the only reliable
    // signal a native-HLS failure happened. The listener parameter matches
    // the adapter's EventLike shape structurally — @videojs/media is not a
    // direct dependency to import the type from.
    const onAdapterError = (event: {
      readonly type: string
      readonly timeStamp: number
    }) => {
      if (
        usePlatformHls &&
        event instanceof ErrorEvent &&
        event.error?.code === MEDIA_ERR_SRC_NOT_SUPPORTED
      ) {
        setPlatformHlsRejected(true)
      }
    }

    adapter.addEventListener("error", onAdapterError)

    adapter.source = usePlatformHls
      ? { src: sourceUrl, preferPlayback: "native" }
      : { src: sourceUrl }

    return () => {
      adapter.removeEventListener("error", onAdapterError)
    }
  }, [videoComponent, sourceUrl, platformHlsRejected])

  if (videoComponent === null) {
    return null
  }

  const VideoElement = videoComponent

  return (
    <VideoElement
      ref={videoRef}
      mediaRef={adapterRef}
      playsInline
      preload="metadata"
      onError={onError}
    />
  )
}
