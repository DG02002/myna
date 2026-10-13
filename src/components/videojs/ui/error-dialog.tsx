"use client"

import "../styles/base.css"
import "../styles/audio/theme.css"
import "../styles/video/captions.css"
import "../styles/video/theme.css"
import {
  ErrorDialog as ErrorDialogPrimitive,
  selectError,
  usePlayer,
} from "@videojs/react"

import { Button } from "#/components/videojs/ui/button.tsx"
import { cn } from "#/lib/utils.ts"
import {
  isRetryablePlaybackFailure,
  isPlaybackFailure,
  nativeMediaErrorCodeToFailure,
  playbackFailureMessage,
  type PlaybackFailure,
} from "#/media/models/media-errors"

function usePlaybackError() {
  const error = usePlayer(selectError)?.error

  if (!error) {
    return null
  }

  const failure: PlaybackFailure =
    "failure" in error && isPlaybackFailure(error.failure)
      ? error.failure
      : nativeMediaErrorCodeToFailure(error.code)

  return { failure, message: playbackFailureMessage(failure) }
}

export function ErrorDialog({
  onRetryPlayback,
}: {
  onRetryPlayback?: () => void
}) {
  const error = usePlaybackError()

  const canRetry =
    error !== null &&
    onRetryPlayback !== undefined &&
    isRetryablePlaybackFailure(error.failure)

  return (
    // The recovery dialog must cover controls while the error is unresolved.
    <ErrorDialogPrimitive.Root>
      <ErrorDialogPrimitive.Backdrop
        className={cn(
          "absolute inset-0 z-40 bg-media-backdrop/20 opacity-100 backdrop-filter-media-dialog rounded-[inherit]",
          "not-data-open:hidden transition-opacity delay-media-dialog duration-media-dialog ease-out",
          "media-transitioning:opacity-0 data-ending-style:delay-0",
          "data-ending-style:duration-media-slower"
        )}
      />
      <ErrorDialogPrimitive.Popup
        className={cn(
          "absolute top-1/2 left-1/2 z-50 flex w-media-dialog-width max-w-media-dialog max-h-[calc(100%-0.5rem)] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-media-dialog text-media-popover-foreground outline-hidden not-data-open:hidden",
          "text-shadow-media-dialog transition-[opacity,scale] delay-media-dialog duration-media-dialog ease-out",
          "media-transitioning:scale-media-hidden-popup media-transitioning:opacity-0 data-ending-style:delay-0",
          "bg-media-popover surface-media after:surface-media-inset",
          "p-3",
          "data-ending-style:duration-media-slower"
        )}
      >
        <div
          className={cn(
            "flex min-h-0 flex-col gap-2 overflow-y-auto",
            "px-2 pt-2 pb-1.5"
          )}
        >
          <ErrorDialogPrimitive.Title
            className={"m-0 text-media-lg font-semibold leading-tight"}
          >
            {error?.message.title ?? ""}
          </ErrorDialogPrimitive.Title>
          <ErrorDialogPrimitive.Description
            className={"m-0 opacity-70 wrap-anywhere"}
          >
            {error?.message.description ?? ""}
          </ErrorDialogPrimitive.Description>
        </div>
        <div className={"flex shrink-0 gap-2"}>
          {canRetry ? (
            <>
              <ErrorDialogPrimitive.Close
                render={<Button />}
                className={
                  "h-media-control flex-1 px-4 py-2 font-medium text-media-popover-foreground opacity-70 hover:opacity-100"
                }
              >
                Close
              </ErrorDialogPrimitive.Close>
              <ErrorDialogPrimitive.Close
                render={<Button />}
                className={
                  "h-media-control flex-1 bg-media-primary! px-4 py-2 font-medium text-media-primary-foreground!"
                }
                onClick={onRetryPlayback}
              >
                Try again
              </ErrorDialogPrimitive.Close>
            </>
          ) : (
            <ErrorDialogPrimitive.Close
              render={<Button />}
              className={
                "h-media-control w-full flex-1 bg-media-primary! px-4 py-2 font-medium text-media-primary-foreground!"
              }
            >
              OK
            </ErrorDialogPrimitive.Close>
          )}
        </div>
      </ErrorDialogPrimitive.Popup>
    </ErrorDialogPrimitive.Root>
  )
}
