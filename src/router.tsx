import { createRouter as createTanStackRouter } from "@tanstack/react-router"

import { routeTree } from "./routeTree.gen"

export function getRouter() {
  const router = createTanStackRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: "intent",
    defaultStaleTime: Infinity,
    defaultPreloadStaleTime: 30_000,
    defaultGcTime: Infinity,
  })

  return router
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
