import { createFileRoute } from "@tanstack/react-router"

import { PolicyPage, PolicySection } from "#/components/policy-page"
import { policyHead } from "#/lib/policies"

export const Route = createFileRoute("/cookies")({
  head: () => policyHead("cookies"),
  component: CookiesPage,
})

function CookiesPage() {
  return (
    <PolicyPage
      title="Cookies and browser storage"
      introduction="Myna’s app uses browser storage for local media history and a display preference. This page distinguishes that storage from cookies and from technologies that Cloudflare or media hosts control."
    >
      <PolicySection title="Storage used by Myna">
        <p>
          Myna’s app code does not set cookies for player history, appearance,
          analytics, advertising, or sign-in. It uses these browser-local values
          instead:
        </p>
        <div className="overflow-x-auto rounded-xl border border-white/10">
          <table className="w-full min-w-xl border-collapse text-left text-base font-medium leading-relaxed tracking-wide sm:text-lg md:text-xl">
            <thead className="bg-white/5 text-white">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">
                  Browser storage
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  Purpose and duration
                </th>
              </tr>
            </thead>
            <tbody className="text-white/80">
              <tr>
                <th scope="row" className="px-4 py-3 font-mono font-normal">
                  localStorage: myna.history.v1
                </th>
                <td className="px-4 py-3">
                  Saves up to 50 recent media links and related playback details
                  until you remove them or clear this site’s browser storage.
                </td>
              </tr>
              <tr>
                <th scope="row" className="px-4 py-3 font-mono font-normal">
                  localStorage: theme
                </th>
                <td className="px-4 py-3">
                  A display preference read by the app when present. It remains
                  in browser storage until changed or cleared.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>
          The history value contains full media URLs. If a URL has a token or
          other credential in its query string, that value is stored in this
          browser’s local storage with the history entry.
        </p>
      </PolicySection>

      <PolicySection title="Managing browser storage">
        <p>
          Remove an individual item or clear all media history from the app. You
          can also clear Myna’s site data in your browser settings. If browser
          storage is unavailable or cleared, Myna cannot restore the saved
          history from another device or account.
        </p>
        <p>
          Myna has no app-level cookie preference panel. Blocking or clearing
          local storage may prevent the app from remembering history or a theme
          preference; it does not prevent you from entering a media link for the
          current session.
        </p>
      </PolicySection>

      <PolicySection title="Cloudflare and media-host technologies">
        <p>
          Cloudflare hosts Myna and may process request and security data under
          its own services. Media hosts can also use their own cookies or
          browser storage when your browser connects to them. Myna does not
          control those technologies.
        </p>
        <p>
          This inventory covers Myna’s application code. Cloudflare’s hosting
          and security features may use separate cookies or browser storage;
          their use can depend on account configuration. This page does not
          inventory those provider-controlled technologies. Review Cloudflare’s{" "}
          <a
            href="https://www.cloudflare.com/privacypolicy/"
            target="_blank"
            rel="noreferrer"
            className="text-white/80 underline decoration-white/30 underline-offset-4 hover:text-white"
          >
            privacy information
          </a>{" "}
          and the media host’s own notices for their practices.
        </p>
      </PolicySection>
    </PolicyPage>
  )
}
