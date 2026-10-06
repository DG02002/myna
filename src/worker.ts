// Cloudflare Worker entry. Wraps TanStack Start's handler and serves the
// media proxy on /api/media-proxy before framework routing runs.
import {
  createStartHandler,
  defaultStreamHandler,
} from "@tanstack/react-start/server"
import { createServerEntry } from "@tanstack/react-start/server-entry"

import { mediaProxy } from "#/media/proxy/handler"

const MEDIA_PROXY_PATH = "/api/media-proxy"

const appFetch = createStartHandler(defaultStreamHandler)

export default createServerEntry({
  fetch: async (request, ...rest) => {
    if (new URL(request.url).pathname === MEDIA_PROXY_PATH) {
      return mediaProxy(request)
    }

    return appFetch(request, ...rest)
  },
})
