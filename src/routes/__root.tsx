import { TanStackDevtools } from "@tanstack/react-devtools"
import {
  HeadContent,
  Link,
  Scripts,
  createRootRoute,
} from "@tanstack/react-router"
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools"

import { SiteFooter, SiteHeader } from "#/components/site-shell"
import { SITE_DESCRIPTION } from "#/lib/seo"

import appCss from "../styles.css?url"

const THEME_INIT_SCRIPT = `(function(){try{var stored=window.localStorage.getItem('theme');var mode=(stored==='light'||stored==='dark'||stored==='auto')?stored:'auto';var prefersDark=window.matchMedia('(prefers-color-scheme: dark)').matches;var resolved=mode==='auto'?(prefersDark?'dark':'light'):mode;var root=document.documentElement;root.classList.remove('light','dark');root.classList.add(resolved);if(mode==='auto'){root.removeAttribute('data-theme')}else{root.setAttribute('data-theme',mode)}root.style.colorScheme=resolved;}catch(e){}})();`

export const Route = createRootRoute({
  head: () => ({
    meta: [
      {
        charSet: "utf-8",
      },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1",
      },
      {
        title: "Myna",
      },
      {
        name: "description",
        content: SITE_DESCRIPTION,
      },
      {
        name: "theme-color",
        content: "#090e16",
      },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
      {
        rel: "icon",
        href: "/favicon.svg",
        type: "image/svg+xml",
      },
    ],
  }),
  notFoundComponent: NotFoundPage,
  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <HeadContent />
      </head>
      <body className="font-sans antialiased">
        <div className="myna-shell dark bg-background text-foreground flex min-h-svh flex-col">
          <SiteHeader />
          <div className="flex flex-1 flex-col">{children}</div>
          <SiteFooter />
        </div>
        {import.meta.env.DEV && (
          <TanStackDevtools
            config={{
              position: "bottom-right",
            }}
            plugins={[
              {
                name: "Tanstack Router",
                render: <TanStackRouterDevtoolsPanel />,
              },
            ]}
          />
        )}
        <Scripts />
      </body>
    </html>
  )
}

function NotFoundPage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 px-6 py-20 md:px-8 lg:px-8 text-center">
      <p className="text-muted-foreground text-sm font-medium tracking-widest uppercase">
        404
      </p>
      <h1 className="text-3xl font-semibold tracking-tight">
        That page isn&apos;t here.
      </h1>
      <p className="text-muted-foreground max-w-md text-balance">
        Head back to Myna and open a media link from your library.
      </p>
      <Link
        to="/add"
        className="bg-primary text-primary-foreground hover:opacity-90 rounded-xl px-5 py-3 text-sm font-medium transition-opacity duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Open the app
      </Link>
    </main>
  )
}
