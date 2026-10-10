import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useState, type FormEvent } from "react"

import { Button } from "#/components/ui/button"
import { Input } from "#/components/ui/input"
import {
  playbackFailureMessage,
  type PlaybackFailure,
} from "#/media/models/media-errors"
import { parseDirectSource, storeSourceForSession } from "#/media/models/source"

export const Route = createFileRoute("/")({ component: HomePage })

function HomePage() {
  const navigate = useNavigate()
  const [value, setValue] = useState("")
  const [failure, setFailure] = useState<PlaybackFailure | null>(null)

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    const result = parseDirectSource(value)

    if ("failure" in result) {
      setFailure(result.failure)

      return
    }

    storeSourceForSession(result.source)
    void navigate({ to: "/watch" })
  }

  const invalid = failure?.kind === "invalid-media-url"
  const message = failure === null ? null : playbackFailureMessage(failure)

  return (
    <main className="flex min-h-svh flex-col items-center justify-center px-4">
      <section className="w-full max-w-xl space-y-6">
        <div className="space-y-2 text-center">
          <h1 className="text-3xl font-semibold tracking-tight max-sm:text-2xl">
            Myna
          </h1>
          <p className="text-muted-foreground text-balance">
            Paste a direct media link and play it right here.
          </p>
        </div>
        <form className="flex gap-2" onSubmit={submit} noValidate>
          <div className="min-w-0 flex-1">
            <Input
              type="url"
              name="media-url"
              value={value}
              onChange={(event) => {
                setValue(event.target.value)

                if (failure !== null) {
                  setFailure(null)
                }
              }}
              aria-invalid={invalid}
              aria-describedby={message ? "media-url-error" : undefined}
              placeholder="https://example.com/video.mkv"
              autoComplete="off"
              spellCheck={false}
              inputMode="url"
            />
          </div>
          <Button type="submit">Play</Button>
        </form>
        {message ? (
          <p
            id="media-url-error"
            role="alert"
            className="text-destructive text-sm"
          >
            {message.description}
          </p>
        ) : null}
      </section>
    </main>
  )
}
