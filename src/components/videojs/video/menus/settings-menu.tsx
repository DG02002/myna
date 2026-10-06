import type { ComponentProps } from "react"

import { AudioTrackMenu } from "#/components/videojs/ui/audio-track-menu.tsx"
import { CaptionsSubmenu } from "#/components/videojs/ui/captions-submenu.tsx"
import { PlaybackRateSubmenu } from "#/components/videojs/ui/playback-rate-submenu.tsx"
import { QualityMenu } from "#/components/videojs/ui/quality-menu.tsx"
import { SettingsMenu } from "#/components/videojs/ui/settings-menu.tsx"

export type VideoSettingsMenuProps = Omit<
  NonNullable<ComponentProps<typeof SettingsMenu>>,
  "children"
>

export function VideoSettingsMenu(props: VideoSettingsMenuProps = {}) {
  return (
    <SettingsMenu {...props}>
      <QualityMenu />
      <AudioTrackMenu />
      <PlaybackRateSubmenu />
      <CaptionsSubmenu />
    </SettingsMenu>
  )
}
