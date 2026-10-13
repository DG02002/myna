import { Video, VideoPlayer } from "@videojs/react/video"
import { useReducedMotion } from "motion/react"
import { useEffect, useMemo, useState } from "react"

import { AudioTracksContext } from "#/components/player/audio-tracks-context"
import { SubtitleTracksContext } from "#/components/player/subtitle-tracks-context"
import { VideoSkin } from "#/components/videojs/video/skin"
import type { SubtitleTrack } from "#/media/subtitles"

// The marketing demo runs the real player skin — the same VideoPlayer,
// VideoSkin, control bar and settings menus the app uses. There is simply no
// media: the video element never gets a source, so nothing streams, nothing
// decodes, and the transport honestly has nothing to transport. The track
// menus are fed through Myna's own audio/subtitle contexts with static data,
// exactly how the playback stage drives them for a real file.
const DEMO_AUDIO_TRACKS = [
  { id: "en-eac3", label: "English (E-AC-3 5.1)", nativeDecodable: false },
  { id: "es-ac3", label: "Español (AC-3 5.1)", nativeDecodable: false },
  { id: "commentary", label: "Commentary (AAC stereo)", nativeDecodable: true },
]

const DEMO_SUBTITLE_TRACKS: SubtitleTrack[] = [
  {
    id: "en-ass",
    label: "English (ASS)",
    language: "en",
    source: { kind: "external" },
    status: "ready",
    cues: [],
  },
  {
    id: "sv-srt",
    label: "Svenska (SRT)",
    language: "sv",
    source: { kind: "external" },
    status: "ready",
    cues: [],
  },
  {
    id: "en-pgs",
    label: "English forced (PGS)",
    language: "en",
    flags: {
      default: false,
      forced: true,
      hearingImpaired: false,
      visualImpaired: false,
      textDescriptions: false,
      original: false,
      commentary: false,
    },
    source: { kind: "external" },
    status: "ready",
    cues: [],
  },
]

// Each still carries a small color palette for the Plasma background and
// subtitle lines in the three render formats. All images are local WebP
// files, so the page never streams media.
export const DEMO_POSTERS = [
  {
    src: "/demo/12-angry-men.webp",
    palette: ["#514949", "#5e5454"],
    width: 1600,
    height: 960,
    subtitles: {
      ass: "It's not easy to raise my hand and send a boy off to die.",
      srt: "Det är inte lätt att räcka upp handen och skicka en pojke i döden.",
      pgs: "New York County Courthouse · 1957",
    },
  },
  {
    src: "/demo/mindhunter.webp",
    palette: ["#23322e", "#24312d"],
    width: 1600,
    height: 727,
    subtitles: {
      ass: "How do we get ahead of crazy if we don't know how crazy thinks?",
      srt: "Hur ska vi komma före de galna om vi inte vet hur de galna tänker?",
      pgs: "FBI Academy · Quantico, 1977",
    },
  },
  {
    src: "/demo/frieren.webp",
    palette: ["#9a5e74", "#9e6a44"],
    width: 1600,
    height: 900,
    subtitles: {
      ass: "It must be lonely, being alone for hundreds of years.",
      srt: "Det måste vara ensamt att vara ensam i hundratals år.",
      pgs: "Decades after the demon king fell",
    },
  },
  {
    src: "/demo/solo-leveling.webp",
    palette: ["#730600", "#6e0003"],
    width: 1600,
    height: 900,
    subtitles: {
      ass: "I'll get stronger — whatever it takes.",
      srt: "Jag måste bli starkare — vad det än kostar.",
      pgs: "D-rank gate · Seoul",
    },
  },
  {
    src: "/demo/taxi-driver.webp",
    palette: ["#210e02", "#351d01"],
    width: 1600,
    height: 860,
    subtitles: {
      ass: "You talkin' to me?",
      srt: "Pratar du med mig?",
      pgs: "New York City · 1976",
    },
  },
]

// How long each still holds before the reel changes.
const POSTER_ROTATE_MS = 7000

// A shuffle bag, not a dice roll: the stills are shuffled and played
// through before anything repeats — the way music players avoid repeating
// tracks. Reshuffling swaps the head if it would replay the still that just
// finished, so seams never repeat either.
function createPosterBag(avoid: number | null) {
  const bag = DEMO_POSTERS.map((_, posterIndex) => posterIndex)

  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const held = bag[j]

    bag[j] = bag[i]
    bag[i] = held
  }

  const [head] = bag

  if (avoid !== null && head === avoid && bag.length > 1) {
    const swapWith = 1 + Math.floor(Math.random() * (bag.length - 1))
    const held = bag[swapWith]

    bag[swapWith] = head
    bag[0] = held
  }

  return bag
}

// The reel walks a shuffle bag — every still plays once per cycle, in a fresh
// order each cycle and on every visit; reduced motion keeps the first still.
interface PosterReel {
  index: number
  bag: number[]
  rotation: number
}

// Draws the next still from the bag, refilling when the cycle is spent.
function drawFromBag(current: PosterReel): PosterReel {
  const rest = [...current.bag]
  const next = rest.shift()

  if (next === undefined) {
    const fresh = createPosterBag(current.index)
    const redrawn = fresh.shift()

    return {
      index: redrawn ?? current.index,
      bag: fresh,
      rotation: current.rotation + 1,
    }
  }

  return { index: next, bag: rest, rotation: current.rotation + 1 }
}

export function useRotatingPoster() {
  const reduced = useReducedMotion()

  const [reel, setReel] = useState<PosterReel>({
    index: 0,
    bag: [],
    rotation: 0,
  })

  // Random opening still and a fresh bag, dealt after hydration so the
  // server-rendered markup and the client agree on first paint.
  useEffect(() => {
    // The random start must land after hydration; deriving it during
    // render would desync the server and client markup.
    // oxlint-disable-next-line react/set-state-in-effect
    setReel((current) => {
      const bag = createPosterBag(null)

      return {
        index: bag.shift() ?? current.index,
        bag,
        rotation: current.rotation + 1,
      }
    })
  }, [])

  useEffect(() => {
    if (reduced) {
      return undefined
    }

    const rotate = window.setInterval(() => {
      if (!document.hidden) {
        setReel(drawFromBag)
      }
    }, POSTER_ROTATE_MS)

    return () => window.clearInterval(rotate)
  }, [reduced])

  return { index: reel.index, rotation: reel.rotation }
}

export function DemoPlayer({ poster }: { poster: { index: number } }) {
  const [audioId, setAudioId] = useState("en-eac3")
  const [subtitleId, setSubtitleId] = useState<string | null>("en-ass")

  const audioValue = useMemo(
    () => ({
      tracks: DEMO_AUDIO_TRACKS,
      selectedId: audioId,
      selectionLabel: "English",
      selectTrack: setAudioId,
    }),
    [audioId]
  )

  const subtitleValue = useMemo(
    () => ({
      tracks: DEMO_SUBTITLE_TRACKS,
      selectedId: subtitleId,
      selectSubtitle: setSubtitleId,
    }),
    [subtitleId]
  )

  return (
    <div className="myna-demo-static">
      <AudioTracksContext.Provider value={audioValue}>
        <SubtitleTracksContext.Provider value={subtitleValue}>
          <VideoPlayer>
            <VideoSkin
              className="aspect-video w-full rounded-none border-0 after:hidden"
              controlsVisibility="always"
            >
              {/* Rotating stills behind the sourceless video element. */}
              <DemoPoster index={poster.index} />
              <div aria-hidden className="myna-grain absolute inset-0" />
              <Video playsInline preload="none" />
              <DemoSubtitleLine
                selectedId={subtitleId}
                posterIndex={poster.index}
              />
            </VideoSkin>
          </VideoPlayer>
        </SubtitleTracksContext.Provider>
      </AudioTracksContext.Provider>
    </div>
  )
}

function DemoPoster({ index }: { index: number }) {
  return (
    <div aria-hidden className="absolute inset-0">
      {DEMO_POSTERS.map((poster, posterIndex) => (
        <img
          key={poster.src}
          src={poster.src}
          alt=""
          width={poster.width}
          height={poster.height}
          decoding="async"
          className={
            posterIndex === index
              ? "absolute inset-0 h-full w-full object-cover opacity-100 transition-opacity duration-700 ease-out"
              : "absolute inset-0 h-full w-full object-cover opacity-0 transition-opacity duration-700 ease-out"
          }
        />
      ))}
    </div>
  )
}

// ASS uses the white Arial face and dark outline seen in the sample file.
// SRT uses the player's white-on-dark overlay. PGS is image-based, so this
// static line only suggests a bitmap caption; a real PGS track supplies its
// own pixels. The lines sit below the player controls.
function DemoSubtitleLine({
  selectedId,
  posterIndex,
}: {
  selectedId: string | null
  posterIndex: number
}) {
  if (selectedId === null) {
    return null
  }

  const lines = DEMO_POSTERS[posterIndex]?.subtitles

  if (lines === undefined) {
    return null
  }

  if (selectedId === "en-ass") {
    return (
      <p className="absolute inset-x-3 bottom-12 z-10 text-center sm:inset-x-4 sm:bottom-20">
        <span className="myna-subtitle-demo myna-subtitle-ass-outline inline-block max-w-full text-lg leading-snug font-normal text-white sm:text-xl md:text-2xl">
          {lines.ass}
        </span>
      </p>
    )
  }

  if (selectedId === "sv-srt") {
    return (
      <p className="absolute inset-x-3 bottom-12 z-10 text-center sm:inset-x-4 sm:bottom-20">
        <span className="inline-block max-w-full rounded-sm bg-black/75 px-2 py-0.5 text-lg leading-snug text-white shadow-sm sm:px-2 sm:py-1 sm:text-xl md:text-2xl">
          {lines.srt}
        </span>
      </p>
    )
  }

  return (
    <p className="absolute inset-x-3 bottom-12 z-10 text-center sm:inset-x-4 sm:bottom-20">
      <span className="myna-subtitle-demo myna-subtitle-pgs inline-block max-w-full text-lg leading-snug font-normal text-white sm:text-xl md:text-2xl">
        {lines.pgs}
      </span>
    </p>
  )
}
