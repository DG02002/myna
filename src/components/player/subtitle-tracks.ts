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
  type MatroskaAssTrackStream,
  type MatroskaSubtitleReader,
} from "#/media/matroska-subtitles"
import { PgsSubtitleSession } from "#/media/pgs-subtitle-session"
import {
  loadSubtitleCues,
  subtitleTrackName,
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
  embeddedProbeFailed: boolean
}

type SubtitleMedia = HTMLVideoElement | MediabunnyMediaAdapter

interface EmbeddedSubtitleLoad {
  id: string
  controller: AbortController
}

export class SubtitleLoadManager {
  private readonly externalLoads = new Map<string, AbortController>()

  private embeddedLoad: EmbeddedSubtitleLoad | null = null

  addExternalLoad(id: string, controller: AbortController): void {
    this.externalLoads.set(id, controller)
  }

  removeExternalLoad(id: string): void {
    this.externalLoads.delete(id)
  }

  currentEmbeddedLoad(): EmbeddedSubtitleLoad | null {
    return this.embeddedLoad
  }

  startEmbeddedLoad(id: string): EmbeddedSubtitleLoad | null {
    const currentLoad = this.embeddedLoad

    if (currentLoad?.id === id) {
      return null
    }

    currentLoad?.controller.abort()

    const load = { id, controller: new AbortController() }
    this.embeddedLoad = load

    return load
  }

  cancelEmbeddedLoad(id?: string): void {
    const currentLoad = this.embeddedLoad

    if (currentLoad === null || (id !== undefined && currentLoad.id !== id)) {
      return
    }

    currentLoad.controller.abort()
    this.embeddedLoad = null
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
      ? { ...track, status: "available" }
      : track
  })
}

function updateEmbeddedSubtitleTrack({
  setTracks,
  id,
  status,
  cues,
}: {
  setTracks: SetSubtitleTracks
  id: string
  status: SubtitleTrack["status"]
  cues?: SubtitleTrack["cues"]
}): void {
  setTracks((currentTracks) =>
    currentTracks.map((track) => {
      if (track.id !== id) {
        return track
      }

      const updatedTrack = { ...track, status }

      if (cues !== undefined) {
        updatedTrack.cues = cues
      }

      return updatedTrack
    })
  )
}

function canKeepPartialAssTrack(
  signal: AbortSignal,
  hasPackets: boolean
): boolean {
  return !signal.aborted && hasPackets
}

async function loadEmbeddedAssSubtitleContent({
  track,
  trackNumber,
  reader,
  signal,
  setTracks,
  setAssTrackStream,
  setAssTrackStreamId,
}: {
  track: SubtitleTrack
  trackNumber: number
  reader: MatroskaSubtitleReader
  signal: AbortSignal
  setTracks: SetSubtitleTracks
  setAssTrackStream: SetAssTrackStream
  setAssTrackStreamId: SetAssTrackStreamId
}): Promise<void> {
  const stream = reader.streamAssTrack(trackNumber, signal)

  setAssTrackStream(stream)
  setAssTrackStreamId(track.id)

  let hasPackets = false

  const unsubscribePackets = stream.subscribePackets((packets) => {
    hasPackets ||= packets.length > 0
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
      })

      return
    }

    throw error
  } finally {
    unsubscribePackets()
  }

  if (!signal.aborted) {
    updateEmbeddedSubtitleTrack({
      setTracks,
      id: track.id,
      status: "ready",
      cues: [],
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
    setTracks: input.setTracks,
    setAssTrackStream: input.setAssTrackStream,
    setAssTrackStreamId: input.setAssTrackStreamId,
  })
}

async function loadEmbeddedUtf8SubtitleContent(
  input: EmbeddedSubtitleContentInput
): Promise<void> {
  const { track, reader, signal, setTracks } = input

  if (track.source.kind !== "matroska") {
    return
  }

  const cues = await reader.readCues(track.source.trackNumber, signal)

  if (!signal.aborted) {
    updateEmbeddedSubtitleTrack({
      setTracks,
      id: track.id,
      status: "ready",
      cues,
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
  signal.addEventListener("abort", () => session.dispose(), { once: true })

  setPgsSession(session)
  setPgsTrackSessionId(track.id)

  updateEmbeddedSubtitleTrack({
    setTracks: input.setTracks,
    id: track.id,
    status: "ready",
    cues: [],
  })
}

async function loadEmbeddedSubtitle({
  track,
  reader,
  loadManager,
  setTracks,
  setAssTrackStream,
  setAssTrackStreamId,
  setPgsSession,
  setPgsTrackSessionId,
}: {
  track: SubtitleTrack
  reader: MatroskaSubtitleReader
  loadManager: SubtitleLoadManager
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

  updateEmbeddedSubtitleTrack({
    setTracks,
    id: track.id,
    status: "loading",
  })

  try {
    await loadEmbeddedSubtitleContent({
      track,
      reader,
      signal,
      setTracks,
      setAssTrackStream,
      setAssTrackStreamId,
      setPgsSession,
      setPgsTrackSessionId,
    })
  } catch {
    if (!signal.aborted) {
      setAssTrackStream(null)
      setAssTrackStreamId(null)

      if (
        track.source.kind === "matroska" &&
        track.source.codecId === "S_HDMV/PGS"
      ) {
        setPgsSession(null)
        setPgsTrackSessionId(null)
      }

      updateEmbeddedSubtitleTrack({
        setTracks,
        id: track.id,
        status: "failed",
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
  setTracks,
  setAssTrackStream,
  setAssTrackStreamId,
  setPgsSession,
  setPgsTrackSessionId,
}: {
  track: SubtitleTrack
  reader: MatroskaSubtitleReader
  loadManager: SubtitleLoadManager
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
  const [tracks, setTracks] = useState<SubtitleTrack[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selectedIdRef = useRef<string | null>(null)

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

  const registeredTracks = useRef(
    new WeakMap<TextTrackList, TextTrackRegistry>()
  )

  const addSubtitle = useCallback(
    (url: string) => {
      const id = crypto.randomUUID()
      const name = subtitleTrackName(url, tracks.length + 1)
      const controller = new AbortController()

      loadManager.addExternalLoad(id, controller)
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

      void loadSubtitleCues(url, controller.signal)
        .then((result) => {
          if (controller.signal.aborted || "aborted" in result) {
            return
          }

          setTracks((currentTracks) =>
            currentTracks.map((track) => {
              if (track.id !== id) {
                return track
              }

              if ("cues" in result) {
                return { ...track, status: "ready", cues: result.cues }
              }

              return { ...track, status: "failed" }
            })
          )
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setTracks((currentTracks) =>
              currentTracks.map((track) =>
                track.id === id ? { ...track, status: "failed" } : track
              )
            )
          }
        })
        .finally(() => loadManager.removeExternalLoad(id))
    },
    [loadManager, tracks.length]
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
          track.id === id ? { ...track, status: "failed" } : track
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
    ]
  )

  const markSubtitleIncomplete = useCallback((id: string) => {
    updateEmbeddedSubtitleTrack({
      setTracks,
      id,
      status: "incomplete",
    })
  }, [])

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
  }, [matroskaUrl, nativeMediaRef, setEmbeddedProbeFailed, setReader])

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
    setAssTrackStream,
    setAssTrackStreamId,
    setPgsTrackSessionId,
    replacePgsSession,
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
    applyTextTrackSelection(registry, selectedId)

    const syncSelection = () => {
      syncSelectedTrack(registry, selectedIdRef.current, selectSubtitle)
    }

    textTracks.addEventListener("change", syncSelection)
    syncSelection()

    return () => textTracks.removeEventListener("change", syncSelection)
  }, [
    adapter,
    nativeMediaRef,
    selectSubtitle,
    selectedId,
    setNativeBrowserTrackIds,
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
    embeddedProbeFailed,
  }
}

function isAssSubtitleCodec(codecId: string): boolean {
  return codecId === "S_TEXT/ASS" || codecId === "S_TEXT/SSA"
}

function areSetsEqual<T>(left: Set<T>, right: Set<T>): boolean {
  return (
    left.size === right.size && [...left].every((value) => right.has(value))
  )
}

interface TextTrackRegistry {
  registered: Map<string, TextTrack>
  browserMatches: Map<string, TextTrack>
  populated: Set<string>
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
    populated: new Set(),
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
      populateSubtitleTextTrack({ textTrack, subtitle, registry, setTracks })
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
}: {
  textTrack: TextTrack
  subtitle: SubtitleTrack
  registry: TextTrackRegistry
  setTracks: Dispatch<SetStateAction<SubtitleTrack[]>>
}): void {
  if (
    subtitle.status !== "ready" ||
    registry.browserMatches.has(subtitle.id) ||
    registry.populated.has(subtitle.id)
  ) {
    return
  }

  const addedCues: VTTCue[] = []

  try {
    for (const cue of subtitle.cues) {
      const vttCue = new VTTCue(cue.startTime, cue.endTime, cue.text)

      textTrack.addCue(vttCue)
      addedCues.push(vttCue)
    }

    registry.populated.add(subtitle.id)
  } catch {
    for (const cue of addedCues) {
      textTrack.removeCue(cue)
    }

    setSubtitleFailed(setTracks, subtitle.id)
  }
}

function setSubtitleFailed(
  setTracks: Dispatch<SetStateAction<SubtitleTrack[]>>,
  id: string
): void {
  // The effect reports failures from the external TextTrack API.
  setTracks((currentTracks) =>
    currentTracks.map((track) =>
      track.id === id ? { ...track, status: "failed" } : track
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
  // that transient empty state; the Playloom captions menu owns the Off action.
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
