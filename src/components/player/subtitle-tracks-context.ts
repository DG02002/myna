import { createContext, useContext } from "react"

import type { SubtitleTrack } from "#/media/subtitles"

export interface SubtitleTracksValue {
  tracks: SubtitleTrack[]
  selectedId: string | null
  selectSubtitle: (id: string | null) => void
}

export const SubtitleTracksContext = createContext<SubtitleTracksValue | null>(
  null
)

export function usePlayloomSubtitleTracks(): SubtitleTracksValue | null {
  return useContext(SubtitleTracksContext)
}
