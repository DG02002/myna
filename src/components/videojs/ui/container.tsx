"use client"

import "../styles/base.css"
import "../styles/audio/theme.css"
import "../styles/video/captions.css"
import "../styles/video/theme.css"
import {
  Container as ContainerPrimitive,
  useComposedRefs,
  useContainerAttach,
} from "@videojs/react"
import type { Ref } from "react"

import { cn } from "#/lib/utils.ts"

export interface ContainerProps extends Omit<
  ContainerPrimitive.Props,
  "children"
> {
  children?: ContainerPrimitive.Props["children"]
  ref?: Ref<HTMLDivElement>
}

export function Container({
  children,
  className,
  ref,
  ...props
}: ContainerProps) {
  // Media components register with the player through ref callbacks during
  // the commit phase, while the primitive registers this container only in
  // a passive effect. The player store would attach once with media but no
  // container — controlsFeature warns and discards that attach. Registering
  // the container from a ref callback too lands both registrations in the
  // same commit; the primitive's later effect call re-registers the same
  // element and the state setter bails out without a re-render.
  const attachContainer = useContainerAttach()

  return (
    <ContainerPrimitive
      ref={useComposedRefs(ref, attachContainer)}
      className={cn(
        "media-skin",
        "relative isolate block h-full w-full overflow-clip rounded-media-player bg-media-background @container/media-root",
        "[--spacing:var(--media-spacing)] font-media text-media leading-normal subpixel-antialiased",
        "outline-2 -outline-offset-4 outline-transparent transition-[outline-offset,outline-color] duration-media-fast ease-out",
        "focus-visible:outline-media-ring focus-visible:outline-offset-2",
        // Keep the frame edge over video pixels without blocking interaction.
        "after:pointer-events-none after:absolute after:inset-0 after:z-10 after:rounded-[inherit]",
        "after:border after:border-(--media-frame-border) [&:fullscreen]:after:hidden",
        className
      )}
      {...props}
    >
      {children}
    </ContainerPrimitive>
  )
}
