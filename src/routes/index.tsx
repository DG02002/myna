import { ArrowRightIcon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { createFileRoute, Link } from "@tanstack/react-router"
import { motion, MotionConfig, type Variants } from "motion/react"
import { useEffect, useRef, type ReactNode } from "react"

import {
  DEMO_POSTERS,
  DemoPlayer,
  useRotatingPoster,
} from "#/components/marketing/demo-player"
import { GitHubLockup } from "#/components/marketing/github-mark"
import { SITE_DESCRIPTION, SITE_ORIGIN } from "#/lib/seo"

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Myna | Browser Media Player" },
      { name: "description", content: SITE_DESCRIPTION },
      { property: "og:type", content: "website" },
      { property: "og:site_name", content: "Myna" },
      { property: "og:title", content: "Myna | Browser Media Player" },
      { property: "og:description", content: SITE_DESCRIPTION },
      { property: "og:url", content: `${SITE_ORIGIN}/` },
      { name: "twitter:card", content: "summary" },
      { name: "twitter:title", content: "Myna | Browser Media Player" },
      { name: "twitter:description", content: SITE_DESCRIPTION },
    ],
    links: [{ rel: "canonical", href: `${SITE_ORIGIN}/` }],
  }),
  component: MarketingPage,
})

const GITHUB_URL = "https://github.com/DG02002/myna"

const RISE: Variants = {
  hidden: { opacity: 0, y: 12, filter: "blur(4px)" },
  show: {
    opacity: 1,
    y: 0,
    filter: "blur(0px)",
    transition: { duration: 0.3, ease: "easeOut" },
  },
}

const STAGGER: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.1 } },
}

function MarketingPage() {
  return (
    <MotionConfig reducedMotion="user">
      <main className="flex-1">
        <Hero />
        <FormatsSection />
        <OpenSourceSection />
        <AttributionSection />
      </main>
    </MotionConfig>
  )
}

function Hero() {
  // One reel drives everything: the still inside the player, its subtitle
  // lines, and the ambient pools behind the hero — the page glows with
  // whatever is on screen, the way a TV's ambient mode lights the wall.
  const poster = useRotatingPoster()

  const [ambientA, ambientB] = DEMO_POSTERS[poster.index]?.ambient ?? [
    "#000000",
    "#000000",
  ]

  // The swatch lands as custom properties on the section; the
  // myna-ambient-* pools consume them and cross-fade their color with each
  // reel change.
  const heroRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const node = heroRef.current

    if (node === null) {
      return undefined
    }

    node.style.setProperty("--ambient-a", ambientA)
    node.style.setProperty("--ambient-b", ambientB)

    // The first swatch lands instantly — matching the still that is
    // already on screen — and only after that frame do later changes
    // fade, so a refresh never starts from the fallback.
    if (!node.classList.contains("myna-ambient-live")) {
      const frame = requestAnimationFrame(() => {
        node.classList.add("myna-ambient-live")
      })

      return () => cancelAnimationFrame(frame)
    }

    return undefined
  }, [ambientA, ambientB])

  return (
    <section
      ref={heroRef}
      className="myna-section-hero relative -mt-24 overflow-hidden sm:-mt-20"
    >
      {/* Ambient light from the flanks and across the middle, colored by
          the reel on screen, drifting on its own slow clocks */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="myna-ambient-a" />
        <div className="myna-ambient-b" />
        <div className="myna-ambient-c" />
      </div>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-96 sm:h-112"
      >
        <div className="myna-glow myna-glow-neutral" />
      </div>

      <div className="relative mx-auto flex w-full max-w-4xl flex-col items-center px-6 pt-36 pb-0 text-center sm:pt-48 md:pt-52 md:px-8 lg:px-8">
        <motion.div
          variants={STAGGER}
          initial="hidden"
          animate="show"
          className="flex w-full flex-col items-center"
        >
          <motion.h1
            variants={RISE}
            className="myna-display font-medium tracking-tight text-white"
          >
            MKV plays here.
          </motion.h1>

          <motion.p
            variants={RISE}
            className="mt-6 max-w-2xl text-balance text-base font-medium leading-relaxed tracking-wide text-white/90 sm:text-lg md:text-xl"
          >
            Paste a direct link to any media file and play it in your browser.
            Myna decodes surround sound audio and styled subtitles directly on
            your device.
          </motion.p>

          <motion.div
            variants={RISE}
            className="mt-16 flex w-full flex-col items-stretch gap-3 sm:mt-20 sm:w-auto sm:flex-row sm:items-center sm:justify-center sm:gap-4"
          >
            <CallToAction />
            <GitHubButton />
          </motion.div>
        </motion.div>
      </div>

      {/* Cinema player container with direct ambient backlight */}
      <div className="relative mx-auto mt-16 w-full max-w-6xl px-6 pb-16 sm:mt-20 sm:pb-20 md:px-8 lg:px-8">
        {/* Cinema backlight: wraps the player frame and casts light onto the wall */}
        <div
          aria-hidden
          className="myna-player-ambient pointer-events-none absolute -inset-4 sm:-inset-8 md:-inset-12 -z-10"
        >
          <div className="myna-player-ambient-glow" />
        </div>

        <motion.div
          initial={{ opacity: 0, y: 20, scale: 0.98 }}
          whileInView={{ opacity: 1, y: 0, scale: 1 }}
          viewport={{ once: true, margin: "-30px" }}
          transition={{ duration: 0.5, ease: "easeOut" }}
          className="relative overflow-hidden rounded-2xl border border-white/10 shadow-2xl"
        >
          <DemoPlayer poster={poster} />
        </motion.div>
      </div>
    </section>
  )
}

function FormatsSection() {
  return (
    <section className="myna-section myna-glass-edge w-full border-y border-white/10">
      <div className="grid grid-cols-1 divide-y divide-white/10 md:grid-cols-3 md:divide-y-0 md:divide-x">
        {/* Column 1: Video */}
        <div className="myna-section-blue flex flex-col justify-between px-6 pt-14 pb-14 sm:p-10 lg:p-12">
          <div>
            <h2 className="text-4xl font-semibold tracking-tight text-white sm:text-4xl lg:text-5xl">
              Video
            </h2>

            <p className="mt-6 text-sm font-medium leading-relaxed tracking-wide text-white/80 sm:text-base">
              Hardware decoding with client-side WebCodecs fallback.
            </p>

            <div className="mt-8 sm:mt-10">
              <h3 className="text-sm font-semibold uppercase tracking-wider text-white">
                Supported
              </h3>

              <ul className="mt-4 space-y-3 text-sm font-medium leading-relaxed tracking-wide text-white/95 sm:text-base">
                <li>· Matroska (MKV), MP4, WebM</li>
                <li>· AV1</li>
                <li>· HEVC (H.265)</li>
                <li>· H.264 (AVC)</li>
                <li>· VP9</li>
              </ul>
            </div>
          </div>

          <div className="mt-10 border-t border-white/10 pt-6 sm:mt-12">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-white/60">
              Not Supported
            </h3>

            <ul className="mt-3 space-y-2 text-sm font-medium leading-relaxed tracking-wide text-white/70 sm:text-base">
              <li>· Legacy formats (AVI, WMV)</li>
              <li>· DRM-protected streams</li>
            </ul>
          </div>
        </div>

        {/* Column 2: Audio */}
        <div className="myna-section-cyan flex flex-col justify-between px-6 pt-14 pb-14 sm:p-10 lg:p-12">
          <div>
            <h2 className="text-4xl font-semibold tracking-tight text-white sm:text-4xl lg:text-5xl">
              Audio
            </h2>

            <p className="mt-6 text-sm font-medium leading-relaxed tracking-wide text-white/80 sm:text-base">
              On-device WebAssembly decoders for multichannel surround.
            </p>

            <div className="mt-8 sm:mt-10">
              <h3 className="text-sm font-semibold uppercase tracking-wider text-white">
                Supported
              </h3>

              <ul className="mt-4 space-y-3 text-sm font-medium leading-relaxed tracking-wide text-white/95 sm:text-base">
                <li>· Dolby Digital Plus (E-AC-3)</li>
                <li>· Dolby Digital (AC-3)</li>
                <li>· DTS Multichannel Audio</li>
                <li>· AAC, Opus, FLAC</li>
              </ul>
            </div>
          </div>

          <div className="mt-10 border-t border-white/10 pt-6 sm:mt-12">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-white/60">
              Not Supported
            </h3>

            <ul className="mt-3 space-y-2 text-sm font-medium leading-relaxed tracking-wide text-white/70 sm:text-base">
              <li>· Uncompressed multichannel LPCM</li>
              <li>· TrueHD Atmos without spatial hardware</li>
            </ul>
          </div>
        </div>

        {/* Column 3: Subtitles */}
        <div className="myna-section-violet flex flex-col justify-between px-6 pt-14 pb-14 sm:p-10 lg:p-12">
          <div>
            <h2 className="text-4xl font-semibold tracking-tight text-white sm:text-4xl lg:text-5xl">
              Subtitles
            </h2>

            <p className="mt-6 text-sm font-medium leading-relaxed tracking-wide text-white/80 sm:text-base">
              Full styling, custom typography, and bitmap graphics.
            </p>

            <div className="mt-8 sm:mt-10">
              <h3 className="text-sm font-semibold uppercase tracking-wider text-white">
                Supported
              </h3>

              <ul className="mt-4 space-y-3 text-sm font-medium leading-relaxed tracking-wide text-white/95 sm:text-base">
                <li>· ASS &amp; SSA (Styled subtitles)</li>
                <li>· PGS (Blu-ray bitmaps)</li>
                <li>· SRT &amp; WebVTT</li>
              </ul>
            </div>
          </div>

          <div className="mt-10 border-t border-white/10 pt-6 sm:mt-12">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-white/60">
              Not Supported
            </h3>

            <ul className="mt-3 space-y-2 text-sm font-medium leading-relaxed tracking-wide text-white/70 sm:text-base">
              <li>· Binary DVD VobSub (.sub/.idx)</li>
            </ul>
          </div>
        </div>
      </div>
    </section>
  )
}

function OpenSourceSection() {
  return (
    <section className="myna-section myna-section-ice myna-glass-edge py-16 sm:py-28 lg:py-32">
      <div className="mx-auto flex w-full max-w-4xl flex-col items-center px-6 text-center md:px-8 lg:px-8">
        <Reveal className="flex flex-col items-center">
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            aria-label="View Myna on GitHub"
            className="text-white/80 transition-colors hover:text-white"
          >
            <GitHubLockup className="h-8 w-auto text-white sm:h-9" />
          </a>

          <h2 className="mt-8 text-3xl font-semibold tracking-tight text-white text-balance sm:text-4xl lg:text-5xl">
            Free and open source.
          </h2>

          <p className="mx-auto mt-8 max-w-2xl text-base font-medium leading-relaxed text-white/80 sm:text-lg md:text-xl">
            Playback and decoding happen in your browser. When direct byte
            access is blocked, Myna’s Worker can relay media requests to the
            source. Myna does not transcode media or keep a server-side library.
          </p>

          <div className="mt-10 flex justify-center">
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 text-base font-medium text-white/90 underline decoration-white/30 underline-offset-4 transition-colors hover:text-white hover:decoration-white"
            >
              <span>DG02002/myna</span>
              <HugeiconsIcon icon={ArrowRightIcon} className="size-4" />
            </a>
          </div>
        </Reveal>
      </div>
    </section>
  )
}

function AttributionSection() {
  return (
    <section className="myna-section myna-glass-edge border-t border-white/10 bg-black py-16 text-muted-foreground sm:py-28 lg:py-40">
      <div className="mx-auto flex w-full max-w-5xl flex-col items-center px-6 text-center md:px-8 lg:px-8">
        <Reveal className="flex flex-col items-center">
          <h2 className="text-2xl font-semibold tracking-tight text-white text-balance sm:text-3xl md:text-4xl lg:text-5xl">
            Trademark and Attribution Notices
          </h2>

          <div className="mx-auto mt-10 max-w-3xl space-y-6 text-sm font-normal leading-relaxed text-white/70 sm:text-base">
            <p>
              Dolby, Dolby Digital, Dolby Digital Plus, and AC-3 are trademarks
              or registered trademarks of Dolby Laboratories Licensing
              Corporation. DTS and DTS-HD are trademarks or registered
              trademarks of DTS, Inc. All brand and format names are referenced
              for identification and compatibility purposes only.
            </p>

            <p>
              AV1 is an open standard of the Alliance for Open Media (AOMedia).
              VP9 and WebM are trademarks of Google LLC. H.264 (AVC) and H.265
              (HEVC) are standards of their respective standard-setting
              organizations. Matroska (MKV) is an open-standard media container.
            </p>

            <p>
              Myna is free and open-source software released under the MIT
              License. Demo stills are from 12 Angry Men (1957), Taxi Driver
              (1976), Mindhunter, Frieren: Beyond Journey&apos;s End, and Solo
              Leveling — shown for illustration only, with all rights remaining
              with their respective owners.
            </p>
          </div>
        </Reveal>
      </div>
    </section>
  )
}

function Reveal({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12, filter: "blur(4px)" }}
      whileInView={{ opacity: 1, y: 0, filter: "blur(0px)" }}
      viewport={{ once: true, margin: "-30px" }}
      transition={{ duration: 0.3, ease: "easeOut" }}
      className={className}
    >
      {children}
    </motion.div>
  )
}

function CallToAction() {
  return (
    <Link
      to="/add"
      className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex min-h-14 items-center gap-2.5 rounded-full px-8 text-base font-medium transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background max-sm:w-full max-sm:justify-center"
    >
      Open Myna
      <HugeiconsIcon icon={ArrowRightIcon} className="size-5" />
    </Link>
  )
}

function GitHubButton() {
  return (
    <a
      href={GITHUB_URL}
      target="_blank"
      rel="noreferrer"
      aria-label="View Myna on GitHub"
      className="myna-glass hover:bg-white/10 inline-flex min-h-14 items-center justify-center rounded-full px-8 text-base font-medium transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background max-sm:w-full"
    >
      <GitHubLockup className="h-5 w-auto text-white" />
    </a>
  )
}
