// Audio track selection shared between the playback stage (which owns the
// track list and selection) and the player skin's audio track menu. Lives in
// its own module so the skin and the stage never import each other.
import { createContext, useContext } from "react"

interface AudioTrackOption {
  id: string
  label: string
  nativeDecodable: boolean
}

export interface AudioTracksValue {
  tracks: AudioTrackOption[]
  selectedId: string | null
  selectTrack: (id: string) => void
}

export const AudioTracksContext = createContext<AudioTracksValue | null>(null)

export function usePlayloomAudioTracks(): AudioTracksValue | null {
  return useContext(AudioTracksContext)
}
