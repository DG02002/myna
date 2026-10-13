import {
  AiContentGenerator01Icon,
  ArrowRight02Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { AlertDialog } from "radix-ui"
import { useEffect, useRef, useState } from "react"

import { Button } from "#/components/ui/button"
import { cn } from "#/lib/utils"

interface ClipboardPermissionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onAllow: () => Promise<boolean>
}

export function ClipboardPermissionDialog({
  open,
  onOpenChange,
  onAllow,
}: ClipboardPermissionDialogProps) {
  const [carouselStep, setCarouselStep] = useState(0)
  const [isAllowing, setIsAllowing] = useState(false)
  const [allowFailed, setAllowFailed] = useState(false)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const step = open ? carouselStep : 0

  useEffect(() => {
    if (!open) {
      return undefined
    }

    const interval = window.setInterval(() => {
      setCarouselStep((current) => (current + 1) % 3)
    }, 1500)

    return () => window.clearInterval(interval)
  }, [open])

  const handleAllow = async () => {
    setIsAllowing(true)
    setAllowFailed(false)

    try {
      if (await onAllow()) {
        onOpenChange(false)
      } else {
        setAllowFailed(true)
      }
    } catch {
      setAllowFailed(true)
    } finally {
      setIsAllowing(false)
    }
  }

  const handleDialogOpenChange = (nextOpen: boolean) => {
    if (isAllowing && !nextOpen) {
      return
    }

    if (nextOpen) {
      setCarouselStep(0)
      setAllowFailed(false)
    }

    onOpenChange(nextOpen)
  }

  return (
    <AlertDialog.Root open={open} onOpenChange={handleDialogOpenChange}>
      {/* Keep this app-level dialog above page and player controls. */}
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" />
        <AlertDialog.Content
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            document
              .querySelector<HTMLButtonElement>(
                'button[aria-label="Enable clipboard suggestions"]'
              )
              ?.focus()
          }}
          className="dark myna-alert-dialog-content fixed top-1/2 left-1/2 z-50 max-w-md -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-4xl border bg-background text-foreground shadow-lg"
        >
          <div
            aria-hidden="true"
            className="myna-clipboard-dialog-preview relative overflow-hidden rounded-t-4xl bg-muted/35 px-6 py-10 dark:bg-black/30"
          >
            <div className="flex flex-col gap-4">
              <div
                data-visible={step >= 2}
                className="myna-clipboard-suggestion"
              >
                <div className="min-h-0 overflow-hidden">
                  <div className="w-full rounded-md px-1 py-2 text-left">
                    <span className="shimmer shimmer-color-clipboard-shimmer shimmer-duration-3000 block max-w-full truncate text-base font-normal text-primary">
                      https://example.com/video.mkv
                    </span>
                  </div>
                </div>
              </div>

              <div
                data-step={step}
                className="myna-clipboard-preview-input flex w-full items-center rounded-full border-2 bg-background/30 pl-5 pr-1 transition-colors duration-500"
              >
                <span className="flex-1 text-base text-muted-foreground">
                  Paste link
                </span>
                <span className="flex size-11 items-center justify-center rounded-full bg-foreground/35 text-background">
                  <HugeiconsIcon
                    icon={ArrowRight02Icon}
                    strokeWidth={2}
                    className="size-6"
                  />
                </span>
              </div>
            </div>

            <svg
              viewBox="0 0 28 28"
              data-step={step}
              className="myna-clipboard-cursor"
            >
              <path
                d="M5 3.5 22.1 17l-8.4 1.2-4.6 7.1L5 3.5Z"
                strokeWidth="1.6"
                strokeLinejoin="round"
              />
            </svg>
          </div>

          <div className="flex flex-col items-center px-10 pt-6 pb-10 text-center">
            <ClipboardAccessIcon className="size-12" shimmerVisible={open} />
            <AlertDialog.Title className="mt-4 w-full text-2xl leading-tight font-normal sm:text-3xl">
              Paste links faster
            </AlertDialog.Title>
            <AlertDialog.Description className="mt-4 w-full text-pretty text-base text-muted-foreground">
              Allow clipboard access and Myna can spot a copied link and offer
              it above this input. Nothing plays until you choose the link.
            </AlertDialog.Description>

            <div className="myna-clipboard-dialog-actions mt-8 flex w-full flex-col gap-3">
              <Button
                size="lg"
                disabled={isAllowing}
                onClick={() => void handleAllow()}
              >
                {isAllowing ? "Checking access…" : "Allow clipboard access"}
              </Button>
              <AlertDialog.Cancel asChild>
                <Button
                  ref={cancelRef}
                  variant="outline"
                  size="lg"
                  disabled={isAllowing}
                >
                  Not now
                </Button>
              </AlertDialog.Cancel>
            </div>
            {allowFailed ? (
              <p className="mt-4 text-sm text-destructive" role="alert">
                Clipboard access was blocked. Paste a media URL into the field
                instead.
              </p>
            ) : null}
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}

export function ClipboardAccessIcon({
  className,
  shimmerVisible,
}: {
  className?: string
  shimmerVisible: boolean
}) {
  return (
    <span
      data-shimmer-visible={shimmerVisible}
      className={cn("relative inline-flex text-primary/25", className)}
    >
      <HugeiconsIcon
        icon={AiContentGenerator01Icon}
        strokeWidth={1.5}
        className="size-full"
      />
      <span className="myna-clipboard-icon-shimmer absolute inset-0">
        <HugeiconsIcon
          icon={AiContentGenerator01Icon}
          strokeWidth={1.5}
          className="size-full"
        />
      </span>
    </span>
  )
}
