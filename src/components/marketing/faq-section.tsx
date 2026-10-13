import { Accordion } from "@base-ui/react/accordion"

const FAQ_ITEMS = [
  {
    id: "default-tracks",
    question: "Can I set default audio and subtitle tracks?",
    answer:
      "Not yet. You can choose tracks during playback; saved defaults are planned.",
  },
  {
    id: "subtitle-fonts",
    question: "Can I change subtitle fonts?",
    answer:
      "ASS/SSA subtitles use styles in the file and embedded fonts when available. Font controls for SRT and ASS/SSA subtitles are planned.",
  },
  {
    id: "share-links",
    question: "What does a share link include?",
    answer:
      "A watch link includes the original media URL. Anyone with the link can inspect and reuse it.",
  },
]

export function FAQSection() {
  return (
    <section
      aria-labelledby="faq-title"
      className="myna-section myna-section-faq myna-glass-edge py-16 sm:py-24 typeset typeset-marketing"
    >
      <div className="mx-auto w-full max-w-5xl px-6 md:px-8 lg:px-8">
        <header className="mx-auto max-w-3xl text-center">
          <h2 id="faq-title" className="myna-title font-semibold text-white">
            FAQ
          </h2>
        </header>

        <Accordion.Root
          className="mx-auto mt-10 max-w-3xl border-y border-white/15"
          hiddenUntilFound
        >
          {FAQ_ITEMS.map((item) => (
            <Accordion.Item
              key={item.id}
              value={item.id}
              className="border-b border-white/10 last:border-b-0"
            >
              <Accordion.Header>
                <Accordion.Trigger className="group flex min-h-16 w-full items-center justify-between gap-4 py-5 text-left font-medium text-white transition-colors hover:text-white/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
                  <span>{item.question}</span>
                  <svg
                    aria-hidden="true"
                    className="size-5 shrink-0 transition-transform duration-200 group-data-[panel-open]:rotate-45"
                    fill="none"
                    viewBox="0 0 20 20"
                  >
                    <path
                      d="M10 3.5v13M3.5 10h13"
                      stroke="currentColor"
                      strokeLinecap="round"
                      strokeWidth="1.5"
                    />
                  </svg>
                </Accordion.Trigger>
              </Accordion.Header>
              <Accordion.Panel className="overflow-hidden text-white/75">
                <p className="max-w-3xl pb-5 pr-9">{item.answer}</p>
              </Accordion.Panel>
            </Accordion.Item>
          ))}
        </Accordion.Root>
      </div>
    </section>
  )
}
