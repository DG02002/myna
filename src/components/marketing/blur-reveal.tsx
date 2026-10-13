import {
  AnimatePresence,
  motion,
  useReducedMotion,
  type Variants,
} from "motion/react"

const HERO_TITLES = [
  "Stream MKV.",
  "Switch audio.",
  "Pick subtitles.",
  "Resume here.",
]

const REVEAL: Variants = {
  hidden: {},
  visible: {
    transition: { staggerChildren: 0.025 },
  },
  exit: {
    transition: { staggerChildren: 0.012, staggerDirection: -1 },
  },
}

const CHARACTER: Variants = {
  hidden: { opacity: 0, filter: "blur(10px)", y: 8 },
  visible: {
    opacity: 1,
    filter: "blur(0px)",
    y: 0,
    transition: { duration: 0.32, ease: "easeOut" },
  },
  exit: {
    opacity: 0,
    filter: "blur(10px)",
    y: -6,
    transition: { duration: 0.18, ease: "easeIn" },
  },
}

export function BlurReveal({
  className,
  rotation,
}: {
  className?: string
  rotation: number
}) {
  const shouldReduceMotion = useReducedMotion()
  const title = HERO_TITLES[rotation % HERO_TITLES.length] ?? HERO_TITLES[0]
  const occurrences = new Map<string, number>()

  const characters = Array.from(title, (character) => {
    const occurrence = occurrences.get(character) ?? 0
    occurrences.set(character, occurrence + 1)

    return {
      character,
      key: `${character.codePointAt(0)}-${occurrence}`,
    }
  })

  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.h1
        key={title}
        aria-label={title}
        className={className}
        initial={shouldReduceMotion ? false : "hidden"}
        animate="visible"
        exit="exit"
        variants={REVEAL}
      >
        <span aria-hidden="true" className="inline-flex whitespace-nowrap">
          {characters.map(({ character, key }) => (
            <motion.span
              key={key}
              className="inline-block whitespace-pre"
              variants={CHARACTER}
            >
              {character}
            </motion.span>
          ))}
        </span>
      </motion.h1>
    </AnimatePresence>
  )
}
