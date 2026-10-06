import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({ component: HomePage })

function HomePage() {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-2 px-4">
      <h1 className="text-2xl font-semibold tracking-tight">Playloom</h1>
      <p className="text-muted-foreground text-sm">
        Paste a direct media URL to play it.
      </p>
    </main>
  )
}
