import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react"

import { MediabunnyMediaAdapter } from "#/media/engines/mediabunny-adapter"
import {
  createMatroskaSubtitleReader,
  MatroskaSubtitleError,
  matroskaSubtitleWindowForTargetTime,
  matroskaTextSubtitleWindowForTargetTime,
  type MatroskaAssTrackStream,
  type MatroskaSubtitleReadProgress,
  type MatroskaSubtitleReader,
} from "#/media/matroska-subtitles"
import { PgsSubtitleSession } from "#/media/pgs-subtitle-session"
import {
  loadSubtitleCues,
  subtitleTrackName,
  type SubtitleLoadProgress,
  type SubtitleLoadResult,
  type SubtitleTrack,
} from "#/media/subtitles"

export interface SubtitleTracksState {
  tracks: SubtitleTrack[]
  selectedId: string | null
  selectedTrack: SubtitleTrack | undefined
  addSubtitle: (url: string) => void
  restoreSelection: (id: string | null) => void
  assTrackStream: MatroskaAssTrackStream | null
  pgsSession: PgsSubtitleSession | null
  failSubtitle: (id: string) => void
  markSubtitleIncomplete: (id: string) => void
  retrySubtitle: (id: string) => void
  embeddedProbeFailed: boolean
}

type SubtitleMedia = HTMLVideoElement | MediabunnyMediaAdapter

interface EmbeddedSubtitleLoad {
  id: string
  controller: AbortController
  generation: number
}

export class SubtitleLoadManager {
  private readonly externalLoads = new Map<string, AbortController>()

  private embeddedLoad: EmbeddedSubtitleLoad | null = null

  // Preserve the generation after completion so queued React updates can run.
  // Cancellation or replacement advances it to reject stale updates.
  private embeddedLoadGeneration = 0

  private latestEmbeddedLoadId: string | null = null

  addExternalLoad(id: string, controller: AbortController): void {
    this.cancelExternalLoad(id)
    this.externalLoads.set(id, controller)
  }

  removeExternalLoad(id: string, controller?: AbortController): void {
    if (controller !== undefined && this.externalLoads.get(id) !== controller) {
      return
    }

    this.externalLoads.delete(id)
  }

  cancelExternalLoad(id: string): void {
    const controller = this.externalLoads.get(id)

    if (controller === undefined) {
      return
    }

    controller.abort()
    this.externalLoads.delete(id)
  }

  currentEmbeddedLoad(): EmbeddedSubtitleLoad | null {
    return this.embeddedLoad
  }

  isCurrentEmbeddedLoad(load: EmbeddedSubtitleLoad): boolean {
    return (
      this.embeddedLoadGeneration === load.generation &&
      !load.controller.signal.aborted
    )
  }

  startEmbeddedLoad(id: string): EmbeddedSubtitleLoad | null {
    const currentLoad = this.embeddedLoad

    if (currentLoad?.id === id) {
      return null
    }

    currentLoad?.controller.abort()

    const load = {
      id,
      controller: new AbortController(),
      generation: ++this.embeddedLoadGeneration,
    }

    this.embeddedLoad = load
    this.latestEmbeddedLoadId = id

    return load
  }

  cancelEmbeddedLoad(id?: string): void {
    const currentLoad = this.embeddedLoad

    if (currentLoad !== null && id !== undefined && currentLoad.id !== id) {
      return
    }

    if (currentLoad !== null) {
      currentLoad.controller.abort()
      this.embeddedLoad = null
    } else if (id !== undefined && this.latestEmbeddedLoadId !== id) {
      return
    }

    this.embeddedLoadGeneration += 1
    this.latestEmbeddedLoadId = null
  }

  clearEmbeddedLoad(load: EmbeddedSubtitleLoad): void {
    if (this.embeddedLoad === load) {
      this.embeddedLoad = null
    }
  }

  dispose(): void {
    for (const controller of this.externalLoads.values()) {
      controller.abort()
    }

    this.externalLoads.clear()
    this.cancelEmbeddedLoad()
  }
}

type SetSubtitleTracks = (
  update: (currentTracks: SubtitleTrack[]) => SubtitleTrack[]
) => void

type SetAssTrackStream = (stream: MatroskaAssTrackStream | null) => void

type SetAssTrackStreamId = (id: string | null) => void

type SetPgsSession = (session: PgsSubtitleSession | null) => void

type SetPgsTrackSessionId = (id: string | null) => void

interface EmbeddedSubtitleContentInput {
  track: SubtitleTrack
  reader: MatroskaSubtitleReader
  signal: AbortSignal
  targetTime: number
  preserveExistingWindow?: boolean
  setTracks: SetSubtitleTracks
  setAssTrackStream: SetAssTrackStream
  setAssTrackStreamId: SetAssTrackStreamId
  setPgsSession: SetPgsSession
  setPgsTrackSessionId: SetPgsTrackSessionId
}

function useEmbeddedSubtitleState() {
  const [assTrackStream, setAssTrackStream] =
    useState<MatroskaAssTrackStream | null>(null)

  const [assTrackStreamId, setAssTrackStreamId] = useState<string | null>(null)

  const [nativeBrowserTrackIds, setNativeBrowserTrackIds] = useState<
    Set<string>
  >(() => new Set())

  const [reader, setReader] = useState<MatroskaSubtitleReader | null>(null)
  const [embeddedProbeFailed, setEmbeddedProbeFailed] = useState(false)

  return {
    assTrackStream,
    setAssTrackStream,
    assTrackStreamId,
    setAssTrackStreamId,
    nativeBrowserTrackIds,
    setNativeBrowserTrackIds,
    reader,
    setReader,
    embeddedProbeFailed,
    setEmbeddedProbeFailed,
  }
}

function usePgsSubtitleState() {
  const [pgsSession, setPgsSession] = useState<PgsSubtitleSession | null>(null)

  const [pgsTrackSessionId, setPgsTrackSessionId] = useState<string | null>(
    null
  )

  const pgsSessionRef = useRef<PgsSubtitleSession | null>(null)

  const replacePgsSession = useCallback(
    (session: PgsSubtitleSession | null) => {
      const previous = pgsSessionRef.current

      if (previous !== session) {
        previous?.dispose()
        pgsSessionRef.current = session
        setPgsSession(session)
      }
    },
    []
  )

  const hasPgsSession = useCallback(() => pgsSessionRef.current !== null, [])

  useEffect(() => {
    return () => {
      pgsSessionRef.current?.dispose()
      pgsSessionRef.current = null
    }
  }, [])

  return {
    pgsSession,
    pgsTrackSessionId,
    replacePgsSession,
    setPgsTrackSessionId,
    hasPgsSession,
  }
}

function useSubtitleLoadManager(): SubtitleLoadManager {
  const manager = useMemo(() => new SubtitleLoadManager(), [])

  useEffect(() => {
    return () => manager.dispose()
  }, [manager])

  return manager
}

function releaseSelectedSubtitle(
  tracks: SubtitleTrack[],
  selectedId: string | null,
  releasedStreamTrackId: string | null
): SubtitleTrack[] {
  return tracks.map((track) => {
    const selectedLoadWasCancelled =
      track.id === selectedId &&
      track.source.kind === "matroska" &&
      track.status === "loading"

    const completedAssTrackWasReleased =
      track.id === releasedStreamTrackId &&
      track.source.kind === "matroska" &&
      (isAssSubtitleCodec(track.source.codecId) ||
        track.source.codecId === "S_HDMV/PGS") &&
      (track.status === "ready" || track.status === "incomplete")

    return selectedLoadWasCancelled || completedAssTrackWasReleased
      ? { ...track, status: "available", loadProgress: undefined }
      : track
  })
}

function updateEmbeddedSubtitleTrack({
  setTracks,
  id,
  status,
  cues,
  loadProgress,
  coverage,
  failure,
}: {
  setTracks: SetSubtitleTracks
  id: string
  status: SubtitleTrack["status"]
  cues?: SubtitleTrack["cues"]
  loadProgress?: SubtitleLoadProgress
  coverage?: SubtitleTrack["coverage"] | null
  failure?: SubtitleTrack["failure"] | null
}): void {
  setTracks((currentTracks) =>
    currentTracks.map((track) => {
      if (track.id !== id) {
        return track
      }

      const updatedTrack: SubtitleTrack = { ...track, status }

      if (cues !== undefined) {
        updatedTrack.cues = cues
      }

      if (coverage !== undefined) {
        updatedTrack.coverage = coverage ?? undefined
      }

      if (failure !== undefined) {
        updatedTrack.failure = failure ?? undefined
      }

      // Terminal statuses carry no progress; assigning (not spreading)
      // keeps the field in sync either way.
      updatedTrack.loadProgress = loadProgress

      return updatedTrack
    })
  )
}

function retryPgsSubtitleWindow({
  track,
  id,
  sessionId,
  session,
  setTracks,
}: {
  track: SubtitleTrack
  id: string
  sessionId: string | null
  session: PgsSubtitleSession | null
  setTracks: SetSubtitleTracks
}): boolean {
  if (
    track.source.kind !== "matroska" ||
    track.source.codecId !== "S_HDMV/PGS" ||
    sessionId !== id ||
    session === null ||
    session.failed
  ) {
    return false
  }

  if (session.retryWindow()) {
    updateEmbeddedSubtitleTrack({
      setTracks,
      id,
      status: "loading",
      failure: null,
    })
  }

  return true
}

function canKeepPartialAssTrack(
  signal: AbortSignal,
  hasPackets: boolean
): boolean {
  return !signal.aborted && hasPackets
}

function subtitleFailure(error: Error): SubtitleTrack["failure"] {
  if (!(error instanceof MatroskaSubtitleError)) {
    return { kind: "unreachable" }
  }

  if (error.kind === "deadline" || error.kind === "timeout") {
    return {
      kind: "timeout",
      status: error.status ?? undefined,
      retryAfterMs: error.retryAfterMs,
    }
  }

  if (error.kind === "aborted") {
    return { kind: "unreachable" }
  }

  return {
    kind: error.kind,
    status: error.status ?? undefined,
    retryAfterMs: error.retryAfterMs,
  }
}

export function startExternalSubtitleLoad({
  id,
  url,
  controller,
  loadManager,
  setTracks,
}: {
  id: string
  url: string
  controller: AbortController
  loadManager: SubtitleLoadManager
  setTracks: SetSubtitleTracks
}): void {
  loadManager.addExternalLoad(id, controller)

  void loadSubtitleCues(url, controller.signal, (progress) => {
    if (controller.signal.aborted) {
      return
    }

    setTracks((currentTracks) =>
      currentTracks.map((track) =>
        track.id === id
          ? {
              ...track,
              status: "loading",
              loadProgress: {
                kind: "bytes",
                loadedBytes: progress.loadedBytes,
                totalBytes: progress.totalBytes,
              },
            }
          : track
      )
    )
  })
    .then((result) => {
      if (controller.signal.aborted || "aborted" in result) {
        return
      }

      setTracks((currentTracks) =>
        currentTracks.map((track) =>
          track.id === id ? externalSubtitleResult(track, result) : track
        )
      )
    })
    .catch(() => {
      if (!controller.signal.aborted) {
        setTracks((currentTracks) =>
          currentTracks.map((track) =>
            track.id === id
              ? {
                  ...track,
                  status: "failed",
                  failure: { kind: "unreachable" },
                  loadProgress: undefined,
                }
              : track
          )
        )
      }
    })
    .finally(() => loadManager.removeExternalLoad(id, controller))
}

function externalSubtitleResult(
  track: SubtitleTrack,
  result: Exclude<SubtitleLoadResult, { aborted: true }>
): SubtitleTrack {
  if ("cues" in result) {
    return {
      ...track,
      status: "ready",
      cues: result.cues,
      failure: undefined,
      loadProgress: undefined,
    }
  }

  return {
    ...track,
    status: "failed",
    failure: result.failure,
    loadProgress: undefined,
  }
}

function appendSubtitleCueBatch(
  current: SubtitleTrack["cues"],
  incoming: SubtitleTrack["cues"]
): SubtitleTrack["cues"] {
  const unique = new Map(
    current.map((cue) => [
      `${cue.startTime}\u0000${cue.endTime}\u0000${cue.text}`,
      cue,
    ])
  )

  for (const cue of incoming) {
    unique.set(`${cue.startTime}\u0000${cue.endTime}\u0000${cue.text}`, cue)
  }

  return [...unique.values()].toSorted(
    (left, right) => left.startTime - right.startTime
  )
}

async function loadEmbeddedAssSubtitleContent({
  track,
  trackNumber,
  reader,
  signal,
  targetTime,
  preserveExistingWindow,
  setTracks,
  setAssTrackStream,
  setAssTrackStreamId,
}: {
  track: SubtitleTrack
  trackNumber: number
  reader: MatroskaSubtitleReader
  signal: AbortSignal
  targetTime: number
  preserveExistingWindow: boolean
  setTracks: SetSubtitleTracks
  setAssTrackStream: SetAssTrackStream
  setAssTrackStreamId: SetAssTrackStreamId
}): Promise<void> {
  let readProgress: MatroskaSubtitleReadProgress | null = null
  let lastProgressAtMs = 0

  const stream = reader.streamAssTrack({
    trackNumber,
    signal,
    targetTime,
    onProgress: (progress) => {
      readProgress = progress
      const now = performance.now()

      if (
        now - lastProgressAtMs >= 250 ||
        progress.completed === progress.total
      ) {
        lastProgressAtMs = now
        updateEmbeddedSubtitleTrack({
          setTracks,
          id: track.id,
          status: "loading",
          loadProgress: { kind: "steps", ...progress },
        })
      }
    },
  })

  let hasPackets = false
  let cuesLoaded = 0

  const unsubscribePackets = stream.subscribePackets((packets) => {
    if (!hasPackets && packets.length > 0) {
      setAssTrackStream(stream)
      setAssTrackStreamId(track.id)
    }

    hasPackets ||= packets.length > 0
    cuesLoaded += packets.length

    updateEmbeddedSubtitleTrack({
      setTracks,
      id: track.id,
      status: "loading",
      loadProgress:
        readProgress === null
          ? { kind: "cues", cuesLoaded }
          : { kind: "steps", ...readProgress },
    })
  })

  try {
    await stream.result
  } catch (error) {
    // Packet delivery is the safe boundary: preserve cues already sent to the renderer.
    if (canKeepPartialAssTrack(signal, hasPackets)) {
      updateEmbeddedSubtitleTrack({
        setTracks,
        id: track.id,
        status: "incomplete",
        failure: subtitleFailure(
          error instanceof Error ? error : new Error("Subtitle loading failed.")
        ),
      })

      return
    }

    throw error
  } finally {
    unsubscribePackets()
  }

  if (!signal.aborted) {
    if (preserveExistingWindow && !hasPackets) {
      setAssTrackStream(null)
      setAssTrackStreamId(null)
    }

    const coverage = matroskaSubtitleWindowForTargetTime(targetTime)

    updateEmbeddedSubtitleTrack({
      setTracks,
      id: track.id,
      status: "ready",
      cues: [],
      coverage,
      failure: null,
    })
  }
}

async function loadEmbeddedSubtitleContent(
  input: EmbeddedSubtitleContentInput
): Promise<void> {
  const { track } = input

  if (track.source.kind !== "matroska") {
    return
  }

  if (track.source.codecId === "S_TEXT/UTF8") {
    await loadEmbeddedUtf8SubtitleContent(input)

    return
  }

  if (track.source.codecId === "S_HDMV/PGS") {
    await loadEmbeddedPgsSubtitleContent(input)

    return
  }

  await loadEmbeddedAssSubtitleContent({
    track,
    trackNumber: track.source.trackNumber,
    reader: input.reader,
    signal: input.signal,
    targetTime: input.targetTime,
    preserveExistingWindow: input.preserveExistingWindow ?? false,
    setTracks: input.setTracks,
    setAssTrackStream: input.setAssTrackStream,
    setAssTrackStreamId: input.setAssTrackStreamId,
  })
}

function useExternalSubtitleUrls(): Map<string, string> {
  const urls = useMemo(() => new Map<string, string>(), [])

  useEffect(() => () => urls.clear(), [urls])

  return urls
}

function retryExternalSubtitleLoad({
  id,
  url,
  track,
  loadManager,
  setTracks,
}: {
  id: string
  url: string | undefined
  track: SubtitleTrack
  loadManager: SubtitleLoadManager
  setTracks: SetSubtitleTracks
}): void {
  if (url === undefined) {
    return
  }

  loadManager.cancelExternalLoad(id)

  const retryingTrack = {
    ...track,
    status: "loading" as const,
    cues: [],
    failure: undefined,
    loadProgress: undefined,
  }

  setTracks((currentTracks) =>
    currentTracks.map((candidate) =>
      candidate.id === id ? retryingTrack : candidate
    )
  )

  startExternalSubtitleLoad({
    id,
    url,
    controller: new AbortController(),
    loadManager,
    setTracks,
  })
}

function retryEmbeddedSubtitle({
  track,
  id,
  sessionId,
  session,
  reader,
  adapter,
  nativeMediaRef,
  useAdvancedEngine,
  loadManager,
  replacePgsSession,
  setAssTrackStream,
  setAssTrackStreamId,
  setPgsTrackSessionId,
  setTracks,
}: {
  track: SubtitleTrack
  id: string
  sessionId: string | null
  session: PgsSubtitleSession | null
  reader: MatroskaSubtitleReader | null
  adapter: MediabunnyMediaAdapter | null
  nativeMediaRef: RefObject<HTMLVideoElement | null>
  useAdvancedEngine: boolean
  loadManager: SubtitleLoadManager
  replacePgsSession: (session: PgsSubtitleSession | null) => void
  setAssTrackStream: SetAssTrackStream
  setAssTrackStreamId: SetAssTrackStreamId
  setPgsTrackSessionId: SetPgsTrackSessionId
  setTracks: SetSubtitleTracks
}): void {
  if (
    retryPgsSubtitleWindow({ track, id, sessionId, session, setTracks }) ||
    reader === null
  ) {
    return
  }

  loadManager.cancelEmbeddedLoad(id)

  const preserveExistingWindow =
    track.coverage !== undefined ||
    (track.source.kind === "matroska" &&
      track.source.codecId === "S_TEXT/UTF8" &&
      track.status === "incomplete" &&
      track.cues.length > 0)

  const nextTrack = {
    ...track,
    status: "available" as const,
    failure: undefined,
    loadProgress: undefined,
    cues: preserveExistingWindow ? track.cues : [],
    coverage: preserveExistingWindow ? track.coverage : undefined,
  }

  if (!preserveExistingWindow) {
    setAssTrackStream(null)
    setAssTrackStreamId(null)
  }

  setTracks((currentTracks) =>
    currentTracks.map((candidate) =>
      candidate.id === id ? nextTrack : candidate
    )
  )

  void startEmbeddedSubtitleLoad({
    track: nextTrack,
    reader,
    loadManager,
    targetTime: currentSubtitleTime(
      useAdvancedEngine ? adapter : nativeMediaRef.current
    ),
    preserveExistingWindow,
    setTracks,
    setAssTrackStream,
    setAssTrackStreamId,
    setPgsSession: replacePgsSession,
    setPgsTrackSessionId,
  })
}

async function loadEmbeddedUtf8SubtitleContent(
  input: EmbeddedSubtitleContentInput
): Promise<void> {
  const { track, reader, signal, targetTime, setTracks } = input

  if (track.source.kind !== "matroska") {
    return
  }

  const coverage = matroskaTextSubtitleWindowForTargetTime(targetTime)

  let cueState: EmbeddedCueState = {
    cues: input.preserveExistingWindow
      ? retainCuesInWindow(track.cues, coverage)
      : [],
    cuesLoaded: 0,
    hasNewCues: false,
  }

  try {
    const batches = reader.streamCues({
      trackNumber: track.source.trackNumber,
      targetTime,
      signal,
      onProgress: createSubtitleProgressReporter(track, setTracks),
    })

    for await (const batch of batches) {
      if (signal.aborted) {
        return
      }

      cueState = publishEmbeddedCueBatch({
        track,
        setTracks,
        state: cueState,
        incoming: batch,
        coverage,
      })
    }
  } catch (error) {
    if (signal.aborted) {
      return
    }

    if (cueState.hasNewCues) {
      updateEmbeddedSubtitleTrack({
        setTracks,
        id: track.id,
        status: "incomplete",
        cues: retainCuesInWindow(cueState.cues, coverage),
        coverage: null,
        failure: subtitleFailure(
          error instanceof Error ? error : new Error("Subtitle loading failed.")
        ),
      })

      return
    }

    throw error
  }

  if (!signal.aborted) {
    updateEmbeddedSubtitleTrack({
      setTracks,
      id: track.id,
      status: "ready",
      cues: retainCuesInWindow(cueState.cues, coverage),
      coverage,
      failure: null,
    })
  }
}

function retainCuesInWindow(
  cues: SubtitleTrack["cues"],
  window: { startTime: number; endTime: number }
): SubtitleTrack["cues"] {
  return cues.filter(
    (cue) => cue.endTime > window.startTime && cue.startTime < window.endTime
  )
}

interface EmbeddedCueState {
  cues: SubtitleTrack["cues"]
  cuesLoaded: number
  hasNewCues: boolean
}

function publishEmbeddedCueBatch({
  track,
  setTracks,
  state,
  incoming,
  coverage,
}: {
  track: SubtitleTrack
  setTracks: SetSubtitleTracks
  state: EmbeddedCueState
  incoming: SubtitleTrack["cues"]
  coverage: { startTime: number; endTime: number }
}): EmbeddedCueState {
  const cues = retainCuesInWindow(
    appendSubtitleCueBatch(state.cues, incoming),
    coverage
  )

  const cuesLoaded = state.cuesLoaded + incoming.length

  updateEmbeddedSubtitleTrack({
    setTracks,
    id: track.id,
    status: "loading",
    cues,
    loadProgress: { kind: "cues", cuesLoaded },
    coverage: null,
    failure: null,
  })

  return { cues, cuesLoaded, hasNewCues: true }
}

function createSubtitleProgressReporter(
  track: SubtitleTrack,
  setTracks: SetSubtitleTracks
): (progress: MatroskaSubtitleReadProgress) => void {
  let lastProgressAtMs = 0

  return (progress) => {
    const now = performance.now()

    if (now - lastProgressAtMs < 250 && progress.completed !== progress.total) {
      return
    }

    lastProgressAtMs = now
    updateEmbeddedSubtitleTrack({
      setTracks,
      id: track.id,
      status: "loading",
      loadProgress: { kind: "steps", ...progress },
    })
  }
}

async function loadEmbeddedPgsSubtitleContent(
  input: EmbeddedSubtitleContentInput
): Promise<void> {
  const { track, reader, signal, setPgsSession, setPgsTrackSessionId } = input

  if (track.source.kind !== "matroska") {
    return
  }

  const session = new PgsSubtitleSession()
  const { trackNumber } = track.source

  session.setWindowLoader((targetTime, windowSignal) =>
    reader.streamPgsWindow(trackNumber, targetTime, windowSignal)
  )

  const unsubscribeStatus = session.subscribeWindowStatus((status) => {
    let failure: SubtitleTrack["failure"] | null = null

    if (status !== "ready" && status !== "loading") {
      if (session.failed) {
        failure = { kind: "decode" }
      } else {
        failure = subtitleFailure(
          session.latestWindowFailure ?? new MatroskaSubtitleError("invalid")
        )
      }
    }

    updateEmbeddedSubtitleTrack({
      setTracks: input.setTracks,
      id: track.id,
      status,
      failure,
    })
  })

  signal.addEventListener(
    "abort",
    () => {
      unsubscribeStatus()
      session.dispose()
    },
    { once: true }
  )

  setPgsSession(session)
  setPgsTrackSessionId(track.id)
}

async function loadEmbeddedSubtitle({
  track,
  reader,
  loadManager,
  targetTime,
  preserveExistingWindow,
  setTracks,
  setAssTrackStream,
  setAssTrackStreamId,
  setPgsSession,
  setPgsTrackSessionId,
}: {
  track: SubtitleTrack
  reader: MatroskaSubtitleReader
  loadManager: SubtitleLoadManager
  targetTime: number
  preserveExistingWindow: boolean
  setTracks: SetSubtitleTracks
  setAssTrackStream: SetAssTrackStream
  setAssTrackStreamId: SetAssTrackStreamId
  setPgsSession: SetPgsSession
  setPgsTrackSessionId: SetPgsTrackSessionId
}): Promise<void> {
  if (track.source.kind !== "matroska") {
    return
  }

  const load = loadManager.currentEmbeddedLoad()

  if (load === null || load.id !== track.id) {
    return
  }

  const { signal } = load.controller

  const setTracksForLoad: SetSubtitleTracks = (update) =>
    setTracks((currentTracks) =>
      loadManager.isCurrentEmbeddedLoad(load)
        ? update(currentTracks)
        : currentTracks
    )

  updateEmbeddedSubtitleTrack({
    setTracks: setTracksForLoad,
    id: track.id,
    status: "loading",
    failure: null,
  })

  try {
    await loadEmbeddedSubtitleContent({
      track,
      reader,
      signal,
      targetTime,
      preserveExistingWindow,
      setTracks: setTracksForLoad,
      setAssTrackStream,
      setAssTrackStreamId,
      setPgsSession,
      setPgsTrackSessionId,
    })
  } catch (error) {
    if (!signal.aborted) {
      if (!preserveExistingWindow) {
        setAssTrackStream(null)
        setAssTrackStreamId(null)
      }

      if (
        track.source.kind === "matroska" &&
        track.source.codecId === "S_HDMV/PGS"
      ) {
        setPgsSession(null)
        setPgsTrackSessionId(null)
      }

      updateEmbeddedSubtitleTrack({
        setTracks: setTracksForLoad,
        id: track.id,
        status: "failed",
        failure: subtitleFailure(
          error instanceof Error ? error : new Error("Subtitle loading failed.")
        ),
      })
    }
  } finally {
    loadManager.clearEmbeddedLoad(load)
  }
}

export function startEmbeddedSubtitleLoad({
  track,
  reader,
  loadManager,
  targetTime = 0,
  preserveExistingWindow = false,
  setTracks,
  setAssTrackStream,
  setAssTrackStreamId,
  setPgsSession,
  setPgsTrackSessionId,
}: {
  track: SubtitleTrack
  reader: MatroskaSubtitleReader
  loadManager: SubtitleLoadManager
  targetTime?: number
  preserveExistingWindow?: boolean
  setTracks: SetSubtitleTracks
  setAssTrackStream: SetAssTrackStream
  setAssTrackStreamId: SetAssTrackStreamId
  setPgsSession: SetPgsSession
  setPgsTrackSessionId: SetPgsTrackSessionId
}): Promise<void> | undefined {
  if (track.source.kind !== "matroska" || track.status === "incomplete") {
    return undefined
  }

  const load = loadManager.startEmbeddedLoad(track.id)

  if (load === null) {
    return undefined
  }

  return loadEmbeddedSubtitle({
    track,
    reader,
    loadManager,
    targetTime,
    preserveExistingWindow,
    setTracks,
    setAssTrackStream,
    setAssTrackStreamId,
    setPgsSession,
    setPgsTrackSessionId,
  })
}

export function useSubtitles({
  useAdvancedEngine,
  nativeMediaRef,
  adapter,
  matroskaUrl,
}: {
  useAdvancedEngine: boolean
  nativeMediaRef: RefObject<HTMLVideoElement | null>
  adapter: MediabunnyMediaAdapter | null
  matroskaUrl: string | null
}): SubtitleTracksState {
  const { tracks, setTracks, selectedId, setSelectedId, selectedIdRef } =
    useSubtitleTrackSelectionState()

  const {
    pgsSession,
    pgsTrackSessionId,
    replacePgsSession,
    setPgsTrackSessionId,
    hasPgsSession,
  } = usePgsSubtitleState()

  const {
    assTrackStream,
    setAssTrackStream,
    assTrackStreamId,
    setAssTrackStreamId,
    nativeBrowserTrackIds,
    setNativeBrowserTrackIds,
    reader,
    setReader,
    embeddedProbeFailed,
    setEmbeddedProbeFailed,
  } = useEmbeddedSubtitleState()

  const loadManager = useSubtitleLoadManager()
  const externalSubtitleUrls = useExternalSubtitleUrls()

  const registeredTracks = useRef(
    new WeakMap<TextTrackList, TextTrackRegistry>()
  )

  const addSubtitle = useCallback(
    (url: string) => {
      const id = crypto.randomUUID()
      const name = subtitleTrackName(url, tracks.length + 1)
      const controller = new AbortController()

      externalSubtitleUrls.set(id, url)
      setTracks((currentTracks) => [
        ...currentTracks,
        {
          id,
          ...name,
          source: { kind: "external" },
          status: "loading",
          cues: [],
        },
      ])

      startExternalSubtitleLoad({
        id,
        url,
        controller,
        loadManager,
        setTracks,
      })
    },
    [externalSubtitleUrls, loadManager, setTracks, tracks.length]
  )

  const failSubtitle = useCallback(
    (id: string) => {
      const activeLoad = loadManager.currentEmbeddedLoad()
      const activePgsSession = activeLoad?.id === id && hasPgsSession()

      loadManager.cancelEmbeddedLoad(id)

      if (pgsTrackSessionId === id || activePgsSession) {
        replacePgsSession(null)
        setPgsTrackSessionId(null)
      }

      setTracks((currentTracks) =>
        currentTracks.map((track) =>
          track.id === id
            ? { ...track, status: "failed", loadProgress: undefined }
            : track
        )
      )
      setAssTrackStream(null)
      setAssTrackStreamId(null)
    },
    [
      pgsTrackSessionId,
      hasPgsSession,
      loadManager,
      replacePgsSession,
      setAssTrackStream,
      setAssTrackStreamId,
      setPgsTrackSessionId,
      setTracks,
    ]
  )

  const markSubtitleIncomplete = useCallback(
    (id: string) => {
      updateEmbeddedSubtitleTrack({
        setTracks,
        id,
        status: "incomplete",
      })
    },
    [setTracks]
  )

  const retrySubtitle = useCallback(
    (id: string) => {
      const track = tracks.find((candidate) => candidate.id === id)

      if (track?.source.kind === "external") {
        retryExternalSubtitleLoad({
          id,
          url: externalSubtitleUrls.get(id),
          track,
          loadManager,
          setTracks,
        })

        return
      }

      if (track?.source.kind !== "matroska") {
        return
      }

      retryEmbeddedSubtitle({
        track,
        id,
        sessionId: pgsTrackSessionId,
        session: pgsSession,
        reader,
        adapter,
        nativeMediaRef,
        useAdvancedEngine,
        loadManager,
        replacePgsSession,
        setAssTrackStream,
        setAssTrackStreamId,
        setPgsTrackSessionId,
        setTracks,
      })
    },
    [
      adapter,
      externalSubtitleUrls,
      loadManager,
      nativeMediaRef,
      pgsSession,
      pgsTrackSessionId,
      reader,
      replacePgsSession,
      setAssTrackStream,
      setAssTrackStreamId,
      setPgsTrackSessionId,
      setTracks,
      tracks,
      useAdvancedEngine,
    ]
  )

  const selectSubtitle = useCallback(
    (id: string | null) => {
      const previousSelectedId = selectedIdRef.current

      if (id !== previousSelectedId) {
        const selected = tracks.find((track) => track.id === previousSelectedId)

        const selectedPgsTrack =
          selected?.source.kind === "matroska" &&
          selected.source.codecId === "S_HDMV/PGS"

        const releasedId =
          pgsTrackSessionId ??
          assTrackStreamId ??
          (selectedPgsTrack ? previousSelectedId : null)

        loadManager.cancelEmbeddedLoad()

        if (releasedId !== null) {
          if (releasedId === pgsTrackSessionId || selectedPgsTrack) {
            replacePgsSession(null)
            setPgsTrackSessionId(null)
          }

          setAssTrackStream(null)
          setAssTrackStreamId(null)
        }

        setTracks((currentTracks) =>
          releaseSelectedSubtitle(currentTracks, previousSelectedId, releasedId)
        )
      }

      selectedIdRef.current = id
      setSelectedId(id)
    },
    [
      assTrackStreamId,
      loadManager,
      pgsTrackSessionId,
      replacePgsSession,
      setAssTrackStream,
      setAssTrackStreamId,
      setPgsTrackSessionId,
      selectedIdRef,
      setSelectedId,
      setTracks,
      tracks,
    ]
  )

  useEffect(() => {
    if (matroskaUrl === null) {
      return undefined
    }

    const controller = new AbortController()
    const media = nativeMediaRef.current
    let started = false

    const startProbe = () => {
      if (started) {
        return
      }

      started = true
      const nextReader = createMatroskaSubtitleReader(matroskaUrl)

      void nextReader
        .probe(controller.signal)
        .then((embeddedTracks) => {
          if (controller.signal.aborted) {
            return
          }

          setReader(nextReader)
          setEmbeddedProbeFailed(false)

          setTracks((currentTracks) => {
            const existingIds = new Set(currentTracks.map((track) => track.id))

            const additions = embeddedTracks
              .filter((track) => !existingIds.has(track.id))
              .map<SubtitleTrack>((track) => ({
                id: track.id,
                label: track.label,
                language: track.language,
                flags: track.flags,
                source: {
                  kind: "matroska",
                  trackNumber: track.trackNumber,
                  codecId: track.codecId,
                },
                status: "available",
                cues: [],
              }))

            return [...currentTracks, ...additions]
          })
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            // Embedded subtitle probing is optional and never changes playback state.
            setEmbeddedProbeFailed(true)
          }
        })
    }

    if (media === null || media.readyState >= 1 || media.error !== null) {
      startProbe()

      return () => controller.abort()
    }

    media.addEventListener("loadedmetadata", startProbe, { once: true })
    media.addEventListener("error", startProbe, { once: true })

    return () => {
      controller.abort()
      media.removeEventListener("loadedmetadata", startProbe)
      media.removeEventListener("error", startProbe)
    }
  }, [
    matroskaUrl,
    nativeMediaRef,
    setEmbeddedProbeFailed,
    setReader,
    setTracks,
  ])

  useEffect(() => {
    const selectedTrack = tracks.find((track) => track.id === selectedId)

    const isEmbeddedText =
      selectedTrack?.source.kind === "matroska" &&
      selectedTrack.source.codecId === "S_TEXT/UTF8"

    const isEmbeddedAss =
      selectedTrack?.source.kind === "matroska" &&
      isAssSubtitleCodec(selectedTrack.source.codecId)

    const isEmbeddedPgs =
      selectedTrack?.source.kind === "matroska" &&
      selectedTrack.source.codecId === "S_HDMV/PGS"

    if (
      selectedId === null ||
      reader === null ||
      selectedTrack === undefined ||
      selectedTrack.source.kind !== "matroska" ||
      selectedTrack.status === "ready" ||
      selectedTrack.status === "incomplete" ||
      selectedTrack.status === "failed" ||
      (!isEmbeddedText && !isEmbeddedAss && !isEmbeddedPgs)
    ) {
      return undefined
    }

    if (loadManager.currentEmbeddedLoad()?.id === selectedId) {
      return undefined
    }

    if (
      isEmbeddedPgs &&
      selectedTrack.status === "loading" &&
      pgsTrackSessionId === selectedId
    ) {
      return undefined
    }

    if (!useAdvancedEngine && isEmbeddedAss) {
      const nativeTracks = nativeMediaRef.current?.textTracks

      const matchedTrack =
        nativeTracks === undefined
          ? undefined
          : registeredTracks.current
              .get(nativeTracks)
              ?.browserMatches.get(selectedId)

      if (matchedTrack !== undefined) {
        return undefined
      }
    }

    void startEmbeddedSubtitleLoad({
      track: selectedTrack,
      reader,
      loadManager,
      targetTime: currentSubtitleTime(
        useAdvancedEngine ? adapter : nativeMediaRef.current
      ),
      setTracks,
      setAssTrackStream,
      setAssTrackStreamId,
      setPgsSession: replacePgsSession,
      setPgsTrackSessionId,
    })

    return undefined
  }, [
    nativeMediaRef,
    reader,
    selectedId,
    loadManager,
    adapter,
    setAssTrackStream,
    setAssTrackStreamId,
    setPgsTrackSessionId,
    pgsTrackSessionId,
    replacePgsSession,
    setTracks,
    tracks,
    useAdvancedEngine,
  ])

  useEffect(() => {
    const media: SubtitleMedia | null = useAdvancedEngine
      ? adapter
      : nativeMediaRef.current

    const track = tracks.find((candidate) => candidate.id === selectedId)

    if (
      media === null ||
      reader === null ||
      track?.source.kind !== "matroska" ||
      (track.source.codecId !== "S_TEXT/UTF8" &&
        !isAssSubtitleCodec(track.source.codecId))
    ) {
      return undefined
    }

    const reloadWindow = (targetTime: number) => {
      const { coverage } = track

      if (
        coverage !== undefined &&
        targetTime >= coverage.startTime &&
        targetTime < coverage.endTime - 5
      ) {
        return
      }

      loadManager.cancelEmbeddedLoad(track.id)

      const nextTrack: SubtitleTrack = {
        ...track,
        status: "loading",
        failure: undefined,
        loadProgress: undefined,
      }

      setTracks((currentTracks) =>
        currentTracks.map((candidate) =>
          candidate.id === track.id ? nextTrack : candidate
        )
      )

      void startEmbeddedSubtitleLoad({
        track: nextTrack,
        reader,
        loadManager,
        targetTime,
        preserveExistingWindow: true,
        setTracks,
        setAssTrackStream,
        setAssTrackStreamId,
        setPgsSession: replacePgsSession,
        setPgsTrackSessionId,
      })
    }

    const onSeeked = () => reloadWindow(currentSubtitleTime(media))

    const onTimeUpdate = () => {
      if (
        track.status === "ready" &&
        track.coverage !== undefined &&
        currentSubtitleTime(media) >= track.coverage.endTime - 5
      ) {
        reloadWindow(currentSubtitleTime(media))
      }
    }

    media.addEventListener("seeked", onSeeked)
    media.addEventListener("timeupdate", onTimeUpdate)

    return () => {
      media.removeEventListener("seeked", onSeeked)
      media.removeEventListener("timeupdate", onTimeUpdate)
    }
  }, [
    adapter,
    loadManager,
    nativeMediaRef,
    reader,
    replacePgsSession,
    selectedId,
    setAssTrackStream,
    setAssTrackStreamId,
    setPgsTrackSessionId,
    setTracks,
    tracks,
    useAdvancedEngine,
  ])

  useEffect(() => {
    const media: SubtitleMedia | null = useAdvancedEngine
      ? adapter
      : nativeMediaRef.current

    if (media === null) {
      return undefined
    }

    const { textTracks } = media
    const registry = getTextTrackRegistry(registeredTracks.current, textTracks)

    const syncCues = () => {
      pruneNativeSubtitleCues({ media, tracks, registry })
      registerSubtitleTracks({
        media,
        tracks,
        registry,
        useAdvancedEngine,
        setTracks,
      })
      setNativeBrowserTrackIds((currentIds) => {
        const nextIds = new Set(registry.browserMatches.keys())

        return areSetsEqual(currentIds, nextIds) ? currentIds : nextIds
      })
    }

    syncCues()
    applyTextTrackSelection(registry, selectedId)

    const syncSelection = () => {
      syncSelectedTrack(registry, selectedIdRef.current, selectSubtitle)
    }

    textTracks.addEventListener("change", syncSelection)
    media.addEventListener("timeupdate", syncCues)
    media.addEventListener("seeked", syncCues)
    syncSelection()

    return () => {
      textTracks.removeEventListener("change", syncSelection)
      media.removeEventListener("timeupdate", syncCues)
      media.removeEventListener("seeked", syncCues)
    }
  }, [
    adapter,
    nativeMediaRef,
    selectSubtitle,
    selectedIdRef,
    selectedId,
    setNativeBrowserTrackIds,
    setTracks,
    tracks,
    useAdvancedEngine,
  ])

  const selectedTrack = tracks.find((track) => track.id === selectedId)

  const selectedTrackHasNativeRenderer =
    !useAdvancedEngine &&
    selectedId !== null &&
    nativeBrowserTrackIds.has(selectedId)

  const selectedAssTrackStream =
    selectedTrack?.source.kind === "matroska" &&
    isAssSubtitleCodec(selectedTrack.source.codecId) &&
    selectedTrack.status !== "failed" &&
    assTrackStreamId === selectedId &&
    !selectedTrackHasNativeRenderer
      ? assTrackStream
      : null

  const selectedPgsSession =
    selectedTrack?.source.kind === "matroska" &&
    selectedTrack.source.codecId === "S_HDMV/PGS" &&
    selectedTrack.status !== "failed" &&
    pgsTrackSessionId === selectedId
      ? pgsSession
      : null

  return {
    tracks,
    selectedId,
    selectedTrack,
    addSubtitle,
    restoreSelection: selectSubtitle,
    assTrackStream: selectedAssTrackStream,
    pgsSession: selectedPgsSession,
    failSubtitle,
    markSubtitleIncomplete,
    retrySubtitle,
    embeddedProbeFailed,
  }
}

function useSubtitleTrackSelectionState() {
  const [tracks, setTracks] = useState<SubtitleTrack[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selectedIdRef = useRef<string | null>(null)

  return { tracks, setTracks, selectedId, setSelectedId, selectedIdRef }
}

function isAssSubtitleCodec(codecId: string): boolean {
  return codecId === "S_TEXT/ASS" || codecId === "S_TEXT/SSA"
}

function areSetsEqual<T>(left: Set<T>, right: Set<T>): boolean {
  return (
    left.size === right.size && [...left].every((value) => right.has(value))
  )
}

function currentSubtitleTime(media: SubtitleMedia | null): number {
  if (media === null) {
    return 0
  }

  const time = media.currentTime

  return Number.isFinite(time) ? Math.max(0, time) : 0
}

interface TextTrackRegistry {
  registered: Map<string, TextTrack>
  browserMatches: Map<string, TextTrack>
  populatedCues: Map<string, Map<string, VTTCue>>
  populationCursors: WeakMap<SubtitleTrack["cues"], NativeCuePopulationCursor>
}

interface NativeCuePopulationCursor {
  nextIndex: number
  lastCurrentTime: number
}

const NATIVE_SUBTITLE_FUTURE_RETENTION_SECONDS = 60

function shouldRetainNativeCue(
  cue: Pick<TextTrackCue, "startTime" | "endTime">,
  currentTime: number
): boolean {
  return (
    cue.endTime > currentTime &&
    cue.startTime <= currentTime + NATIVE_SUBTITLE_FUTURE_RETENTION_SECONDS
  )
}

function pruneNativeSubtitleCues({
  media,
  tracks,
  registry,
}: {
  media: SubtitleMedia
  tracks: SubtitleTrack[]
  registry: TextTrackRegistry
}): void {
  const currentTime = currentSubtitleTime(media)

  for (const subtitle of tracks) {
    if (!registry.registered.has(subtitle.id)) {
      continue
    }

    pruneNativeTrackCues(subtitle.id, currentTime, registry)
  }
}

function pruneNativeTrackCues(
  trackId: string,
  currentTime: number,
  registry: TextTrackRegistry
): void {
  const populated = registry.populatedCues.get(trackId)

  if (populated === undefined) {
    return
  }

  const textTrack = registry.registered.get(trackId)

  for (const [key, cue] of populated) {
    if (shouldRetainNativeCue(cue, currentTime)) {
      continue
    }

    if (textTrack !== undefined) {
      try {
        textTrack.removeCue(cue)
      } catch {
        // A source change may already have detached this TextTrack.
      }
    }

    populated.delete(key)
  }

  if (populated.size === 0) {
    registry.populatedCues.delete(trackId)
  }
}

function getTextTrackRegistry(
  registries: WeakMap<TextTrackList, TextTrackRegistry>,
  textTracks: TextTrackList
): TextTrackRegistry {
  const existing = registries.get(textTracks)

  if (existing !== undefined) {
    return existing
  }

  const registry: TextTrackRegistry = {
    registered: new Map(),
    browserMatches: new Map(),
    populatedCues: new Map(),
    populationCursors: new WeakMap(),
  }

  registries.set(textTracks, registry)

  return registry
}

function registerSubtitleTracks({
  media,
  tracks,
  registry,
  useAdvancedEngine,
  setTracks,
}: {
  media: SubtitleMedia
  tracks: SubtitleTrack[]
  registry: TextTrackRegistry
  useAdvancedEngine: boolean
  setTracks: Dispatch<SetStateAction<SubtitleTrack[]>>
}): void {
  const usedBrowserTracks = new Set(registry.browserMatches.values())
  const currentTime = currentSubtitleTime(media)

  for (const subtitle of tracks) {
    const textTrack = getSubtitleTextTrack({
      media,
      subtitle,
      registry,
      useAdvancedEngine,
      usedBrowserTracks,
      setTracks,
    })

    if (textTrack !== undefined) {
      populateSubtitleTextTrack({
        textTrack,
        subtitle,
        registry,
        setTracks,
        currentTime,
      })
    }
  }
}

function getSubtitleTextTrack({
  media,
  subtitle,
  registry,
  useAdvancedEngine,
  usedBrowserTracks,
  setTracks,
}: {
  media: SubtitleMedia
  subtitle: SubtitleTrack
  registry: TextTrackRegistry
  useAdvancedEngine: boolean
  usedBrowserTracks: Set<TextTrack>
  setTracks: Dispatch<SetStateAction<SubtitleTrack[]>>
}): TextTrack | undefined {
  let textTrack =
    registry.registered.get(subtitle.id) ??
    registry.browserMatches.get(subtitle.id)

  if (
    textTrack === undefined &&
    subtitle.source.kind === "matroska" &&
    !useAdvancedEngine &&
    subtitle.source.codecId !== "S_HDMV/PGS"
  ) {
    textTrack = findNativeTrack(media.textTracks, subtitle, usedBrowserTracks)

    if (textTrack !== undefined) {
      registry.browserMatches.set(subtitle.id, textTrack)
      usedBrowserTracks.add(textTrack)
    }
  }

  const shouldRegister =
    (subtitle.source.kind === "matroska" &&
      (subtitle.source.codecId === "S_TEXT/UTF8" ||
        isAssSubtitleCodec(subtitle.source.codecId) ||
        subtitle.source.codecId === "S_HDMV/PGS") &&
      subtitle.status !== "failed") ||
    subtitle.status === "ready"

  if (textTrack !== undefined || !shouldRegister) {
    return textTrack
  }

  try {
    const createdTrack =
      media instanceof MediabunnyMediaAdapter
        ? media.addSubtitleTrack(subtitle.label, subtitle.language)
        : media.addTextTrack("subtitles", subtitle.label, subtitle.language)

    registry.registered.set(subtitle.id, createdTrack)

    return createdTrack
  } catch {
    setSubtitleFailed(setTracks, subtitle.id)

    return undefined
  }
}

function populateSubtitleTextTrack({
  textTrack,
  subtitle,
  registry,
  setTracks,
  currentTime,
}: {
  textTrack: TextTrack
  subtitle: SubtitleTrack
  registry: TextTrackRegistry
  setTracks: Dispatch<SetStateAction<SubtitleTrack[]>>
  currentTime: number
}): void {
  if (
    (subtitle.status !== "ready" &&
      subtitle.status !== "loading" &&
      subtitle.status !== "incomplete") ||
    registry.browserMatches.has(subtitle.id)
  ) {
    return
  }

  const populated = registry.populatedCues.get(subtitle.id) ?? new Map()
  const previousCursor = registry.populationCursors.get(subtitle.cues)

  let cueIndex =
    previousCursor !== undefined &&
    currentTime >= previousCursor.lastCurrentTime
      ? previousCursor.nextIndex
      : 0

  try {
    cueIndex = addRetainedNativeSubtitleCues({
      textTrack,
      cues: subtitle.cues,
      populated,
      cueIndex,
      currentTime,
    })

    registry.populatedCues.set(subtitle.id, populated)
    registry.populationCursors.set(subtitle.cues, {
      nextIndex: cueIndex,
      lastCurrentTime: currentTime,
    })
  } catch {
    clearNativeSubtitleCues(textTrack, populated)

    registry.populatedCues.delete(subtitle.id)
    registry.populationCursors.delete(subtitle.cues)
    setSubtitleFailed(setTracks, subtitle.id)
  }
}

function addRetainedNativeSubtitleCues({
  textTrack,
  cues,
  populated,
  cueIndex,
  currentTime,
}: {
  textTrack: TextTrack
  cues: SubtitleTrack["cues"]
  populated: Map<string, VTTCue>
  cueIndex: number
  currentTime: number
}): number {
  for (; cueIndex < cues.length; cueIndex += 1) {
    const cue = cues[cueIndex]

    if (
      cue === undefined ||
      cue.startTime > currentTime + NATIVE_SUBTITLE_FUTURE_RETENTION_SECONDS
    ) {
      break
    }

    if (!shouldRetainNativeCue(cue, currentTime)) {
      continue
    }

    const key = `${cue.startTime}\u0000${cue.endTime}\u0000${cue.text}`

    if (populated.has(key)) {
      continue
    }

    const vttCue = new VTTCue(cue.startTime, cue.endTime, cue.text)

    textTrack.addCue(vttCue)
    populated.set(key, vttCue)
  }

  return cueIndex
}

function clearNativeSubtitleCues(
  textTrack: TextTrack,
  populated: Map<string, VTTCue>
): void {
  for (const cue of populated.values()) {
    try {
      textTrack.removeCue(cue)
    } catch {
      // A browser may clear its TextTrackList while a source is changing.
    }
  }
}

function setSubtitleFailed(
  setTracks: Dispatch<SetStateAction<SubtitleTrack[]>>,
  id: string
): void {
  // The effect reports failures from the external TextTrack API.
  setTracks((currentTracks) =>
    currentTracks.map((track) =>
      track.id === id
        ? { ...track, status: "failed", loadProgress: undefined }
        : track
    )
  )
}

function applyTextTrackSelection(
  registry: TextTrackRegistry,
  selectedId: string | null
): void {
  const selectedTrack =
    selectedId === null
      ? undefined
      : (registry.registered.get(selectedId) ??
        registry.browserMatches.get(selectedId))

  const uniqueTracks = new Set([
    ...registry.registered.values(),
    ...registry.browserMatches.values(),
  ])

  for (const textTrack of uniqueTracks) {
    const mode = textTrack === selectedTrack ? "showing" : "disabled"

    if (textTrack.mode !== mode) {
      textTrack.mode = mode
    }
  }
}

function syncSelectedTrack(
  registry: TextTrackRegistry,
  selectedId: string | null,
  selectSubtitle: (id: string | null) => void
): void {
  let nextSelectedId: string | null = null

  const selectedTrack =
    selectedId === null
      ? undefined
      : (registry.registered.get(selectedId) ??
        registry.browserMatches.get(selectedId))

  if (selectedTrack?.mode === "showing") {
    nextSelectedId = selectedId
  }

  if (nextSelectedId === null) {
    for (const [id, textTrack] of registry.registered) {
      if (textTrack.mode === "showing") {
        nextSelectedId = id
        break
      }
    }
  }

  if (nextSelectedId === null) {
    for (const [id, textTrack] of registry.browserMatches) {
      if (textTrack.mode === "showing") {
        nextSelectedId = id
        break
      }
    }
  }

  // Browsers may dispatch TextTrackList changes between disabling the old
  // track and showing the new one. Preserve the app's selected track through
  // that transient empty state; the Myna captions menu owns the Off action.
  if (nextSelectedId === null && selectedId !== null) {
    applyTextTrackSelection(registry, selectedId)

    return
  }

  selectSubtitle(nextSelectedId)
}

function findNativeTrack(
  textTracks: TextTrackList,
  subtitle: SubtitleTrack,
  usedTracks: Set<TextTrack>
): TextTrack | undefined {
  const label = normalizeTrackName(subtitle.label)
  const language = normalizeTrackName(subtitle.language)
  let languageMatch: TextTrack | undefined
  let languageMatchCount = 0

  for (let index = 0; index < textTracks.length; index += 1) {
    const textTrack = textTracks[index]

    if (
      textTrack !== undefined &&
      (textTrack.kind === "subtitles" || textTrack.kind === "captions") &&
      !usedTracks.has(textTrack) &&
      normalizeTrackName(textTrack.label) === label &&
      (language.length === 0 ||
        normalizeTrackName(textTrack.language) === language)
    ) {
      return textTrack
    }

    if (
      language.length > 0 &&
      textTrack !== undefined &&
      (textTrack.kind === "subtitles" || textTrack.kind === "captions") &&
      !usedTracks.has(textTrack) &&
      normalizeTrackName(textTrack.language) === language
    ) {
      languageMatch = textTrack
      languageMatchCount += 1
    }
  }

  return languageMatchCount === 1 ? languageMatch : undefined
}

function normalizeTrackName(value: string): string {
  return value.trim().toLowerCase()
}
