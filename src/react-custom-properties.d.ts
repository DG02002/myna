import "react"

// Runtime progress values flow into CSS through custom properties (see the
// myna-progress-fill class in styles.css); React's CSSProperties has no
// custom-property index, so the ones Myna uses are declared here.
declare module "react" {
  interface CSSProperties {
    "--subtitle-progress"?: string
  }
}
