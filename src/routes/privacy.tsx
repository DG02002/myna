import { createFileRoute } from "@tanstack/react-router"

import { PolicyPage, PolicySection } from "#/components/policy-page"
import { policyHead } from "#/lib/policies"

export const Route = createFileRoute("/privacy")({
  head: () => policyHead("privacy"),
  component: PrivacyPage,
})

function PrivacyPage() {
  return (
    <PolicyPage
      title="Privacy policy"
      introduction="This policy describes how Myna handles information when you paste and play a direct media link. It covers Myna’s website and player, not the separate privacy practices of media hosts or your browser."
    >
      <PolicySection title="Information you enter and keep in your browser">
        <p>
          When you play a link, Myna saves a history entry in this browser’s
          local storage. The entry includes the full media URL, a filename,
          available file size, and the times it was added and last played. A URL
          can contain access credentials in its query string.
        </p>
        <p>
          Myna keeps up to 50 recent entries. Replaying a link moves it to the
          top of the list; entries beyond the limit are dropped. Use the
          controls in the app to remove one entry or clear the list, or clear
          Myna’s site data in your browser. Myna does not have user accounts or
          a server-side media library.
        </p>
        <p>
          Myna also reads a browser-local <code>theme</code> preference when one
          is present. It has no sign-in, profile, or payment form in the current
          app.
        </p>
      </PolicySection>

      <PolicySection title="How playback requests work">
        <p>
          Myna starts playback through your browser’s media pipeline. In that
          path, your browser requests the media from the host named by the URL.
          Myna does not control that host or its privacy practices.
        </p>
        <p>
          Some file inspection and advanced playback reads can use Myna’s
          <code>/api/media-proxy</code> endpoint when the browser cannot read
          bytes directly. The browser sends the complete media URL to the Myna
          Worker as an encoded query parameter, and the Worker requests the
          media from its host. The proxy forwards range and cache-validation
          headers; it does not forward the browser’s cookies or authorization
          header.
        </p>
        <p>
          Myna’s own proxy event log records the media host and path, request
          method, response status, outcome, redirect count, and response wait
          time. Unexpected proxy failures also emit error messages to Worker
          logs. The normal proxy event log omits the media URL’s query string.
          The Worker uses the connecting IP address as a rate-limit key.
        </p>
        <p>
          Myna’s Worker configuration enables Cloudflare observability.
          Cloudflare documents invocation logs that can include the request URL.
          A proxy request URL contains the encoded media URL, so that URL can
          appear in Cloudflare Worker logs even though Myna’s own event log
          omits its query string. The project configuration does not identify
          the Cloudflare account plan or its log-retention settings, so this
          policy does not state a fixed retention period. See{" "}
          <a
            href="https://developers.cloudflare.com/workers/observability/logs/workers-logs/"
            target="_blank"
            rel="noreferrer"
            className="text-white/80 underline decoration-white/30 underline-offset-4 hover:text-white"
          >
            Cloudflare Workers Logs documentation
          </a>
          .
        </p>
      </PolicySection>

      <PolicySection title="Sharing a media link">
        <p>
          If you choose Share, Myna creates a link whose URL fragment contains
          the media URL. Anyone who receives that link can inspect and reuse the
          media URL, including any credentials it contains. The share action
          passes the link to your device’s share sheet or clipboard only when
          you choose it.
        </p>
        <p>
          The fragment is resolved in your browser. When the shared Myna page
          first loads, that fragment is not part of the HTTP request to Myna.
          Once playback begins, the browser or proxy makes the media request as
          described above.
        </p>
      </PolicySection>

      <PolicySection title="Service providers and other services">
        <p>
          Cloudflare hosts the Myna app and runs its media proxy. Cloudflare
          processes requests to provide those services. Its handling and
          retention of Worker logs depend on the account plan and settings for
          Myna’s Cloudflare account, which are not specified in the project
          configuration.
        </p>
        <p>
          Media hosts receive requests from your browser or from the Myna proxy,
          depending on the playback path. Their handling of URLs, cookies, IP
          addresses, and media requests is governed by their own terms and
          privacy notices.
        </p>
        <p>
          For provider information, see Cloudflare’s{" "}
          <a
            href="https://www.cloudflare.com/privacypolicy/"
            target="_blank"
            rel="noreferrer"
            className="text-white/80 underline decoration-white/30 underline-offset-4 hover:text-white"
          >
            Privacy Policy
          </a>
          .
        </p>
      </PolicySection>

      <PolicySection title="Your controls and questions">
        <p>
          You can remove saved media history in the app or clear Myna’s site
          data in your browser. These controls do not delete Cloudflare logs or
          records held by a media host. Myna does not provide account-level data
          export or deletion, or an in-app privacy-request form. For general
          product questions, visit the{" "}
          <a
            href="https://github.com/DG02002/myna"
            target="_blank"
            rel="noreferrer"
            className="text-white/80 underline decoration-white/30 underline-offset-4 hover:text-white"
          >
            public Myna repository
          </a>
          . Do not include media URLs, access tokens, or other private
          information in a public post.
        </p>
      </PolicySection>
    </PolicyPage>
  )
}
