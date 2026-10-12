import type { ReactNode } from "react"

export function PolicyPage({
  title,
  introduction,
  children,
}: {
  title: string
  introduction: string
  children: ReactNode
}) {
  return (
    <main className="myna-section mx-auto w-full max-w-6xl flex-1 px-6 py-20 sm:py-24 md:px-8 lg:px-8">
      <article className="mx-auto max-w-5xl">
        <header className="pb-12 sm:pb-16">
          <p className="text-sm font-semibold uppercase tracking-wider text-white/60">
            Last updated October 11, 2026
          </p>
          <h1 className="myna-display mt-8 font-medium tracking-tight text-white sm:mt-10">
            {title}
          </h1>
          <p className="mt-8 text-balance text-base font-medium leading-relaxed tracking-wide text-white/80 sm:mt-10 sm:text-lg md:text-xl">
            {introduction}
          </p>
        </header>

        <div className="mt-8">{children}</div>
      </article>
    </main>
  )
}

export function PolicySection({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  return (
    <section className="space-y-4 py-8 first:pt-0 last:pb-0 sm:py-10">
      <h2 className="myna-title font-semibold tracking-tight text-white">
        {title}
      </h2>
      <div className="space-y-6 text-base font-medium leading-relaxed tracking-wide text-white/80 sm:text-lg md:text-xl">
        {children}
      </div>
    </section>
  )
}
