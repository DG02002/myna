"use client"

import "../styles/base.css"
import "../styles/audio/theme.css"
import "../styles/video/captions.css"
import "../styles/video/theme.css"
import { StatusAnnouncer as StatusAnnouncerPrimitive } from "@videojs/react"

import { resolveClassName } from "#/lib/resolve-class-name.ts"
import { cn } from "#/lib/utils.ts"

export type StatusAnnouncerProps = Omit<
  StatusAnnouncerPrimitive.Props,
  "children"
>

export function StatusAnnouncer({
  className,
  ...props
}: StatusAnnouncerProps = {}) {
  return (
    <StatusAnnouncerPrimitive
      className={(state) => cn("sr-only", resolveClassName(className, state))}
      {...props}
    />
  )
}
