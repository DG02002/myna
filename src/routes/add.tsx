import { createFileRoute } from "@tanstack/react-router"

import { AppPage } from "#/components/app-page"

export const Route = createFileRoute("/add")({
  head: () => ({
    meta: [
      { title: "Add a media link | Myna" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: AppPage,
})
