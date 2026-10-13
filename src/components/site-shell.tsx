import { Link, useRouterState } from "@tanstack/react-router"

import { MynaWordmark } from "#/components/wordmark"

export function SiteHeader() {
  const isHome = useRouterState({
    select: (state) => state.location.pathname === "/",
  })

  return (
    <header className="relative z-20">
      <div
        className={`mx-auto flex w-full max-w-6xl items-center justify-center px-6 md:px-8 lg:px-8 ${
          isHome ? "pt-14 sm:pt-10" : "h-24 sm:h-20"
        }`}
      >
        <Link
          to="/"
          aria-label="Myna home"
          className="rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <MynaWordmark className="text-3xl sm:text-4xl" />
        </Link>
      </div>
    </header>
  )
}

export function SiteFooter() {
  const isHome = useRouterState({
    select: (state) => state.location.pathname === "/",
  })

  return (
    <footer
      className={`relative font-sans ${
        isHome ? "myna-home-footer isolate py-20 sm:py-16" : "py-16 sm:py-10"
      }`}
    >
      <div
        className={`mx-auto flex w-full max-w-6xl flex-col items-center justify-center gap-5 px-6 text-sm font-normal sm:flex-row sm:flex-wrap sm:gap-x-6 sm:gap-y-2 md:px-8 lg:px-8 ${
          isHome
            ? "relative z-10 myna-home-footer-content"
            : "text-muted-foreground"
        }`}
      >
        <nav aria-label="Policy pages" className="max-w-full overflow-x-auto">
          <ul className="flex w-max min-w-full flex-nowrap justify-center gap-x-3 whitespace-nowrap sm:gap-x-5">
            <li>
              <Link
                to="/privacy"
                className="rounded-sm underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Privacy
              </Link>
            </li>
            <li>
              <Link
                to="/cookies"
                className="rounded-sm underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Cookies and storage
              </Link>
            </li>
            <li>
              <Link
                to="/terms"
                className="rounded-sm underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Terms
              </Link>
            </li>
            <li>
              <Link
                to="/usage"
                className="rounded-sm underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Usage
              </Link>
            </li>
          </ul>
        </nav>
        <div className="flex items-center justify-center gap-2 whitespace-nowrap">
          <span>©</span>
          <MynaWordmark className="text-sm opacity-85" />
          <span>·&nbsp; All rights reserved.</span>
        </div>
      </div>
    </footer>
  )
}
