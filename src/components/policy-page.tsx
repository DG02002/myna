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
    <main className="myna-section typeset-policy-page mx-auto w-full max-w-6xl flex-1">
      <article className="typeset typeset-policy mx-auto max-w-5xl">
        <header className="typeset-policy-header">
          <p className="typeset-policy-updated">
            Last updated October 11, 2026
          </p>
          <h1 className="myna-display font-medium tracking-tight text-white">
            {title}
          </h1>
          <p className="text-white/80">{introduction}</p>
        </header>

        <div className="typeset-policy-content">{children}</div>
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
    <section className="typeset-policy-section">
      <h2 className="myna-title font-semibold tracking-tight text-white">
        {title}
      </h2>
      <div className="typeset-flow text-white/80">{children}</div>
    </section>
  )
}
