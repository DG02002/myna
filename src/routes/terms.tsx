import { createFileRoute } from "@tanstack/react-router"

import { PolicyPage, PolicySection } from "#/components/policy-page"
import { policyHead } from "#/lib/policies"

export const Route = createFileRoute("/terms")({
  head: () => policyHead("terms"),
  component: TermsPage,
})

function TermsPage() {
  return (
    <PolicyPage
      title="Terms of use"
      introduction="These terms explain the rules for using Myna’s website, browser media player, and media proxy."
    >
      <PolicySection title="About Myna">
        <p>
          Myna plays direct HTTP or HTTPS media links in your browser. Native
          browser playback starts first. Some file inspection and advanced
          playback reads use Myna’s Cloudflare Worker proxy.
        </p>
        <p>
          Myna can keep up to 50 recent media links in browser storage on the
          device where you use it. It has no user accounts, paid plans, or
          server-side media library.
        </p>
      </PolicySection>

      <PolicySection title="Your media links and content">
        <p>
          You choose the media URL. Use only sources you are authorized to
          access, and follow the terms that apply to the media host and content.
          Myna does not provide access rights to a media source.
        </p>
        <p>
          If you use Share, the generated link contains the original media URL
          in its fragment. Anyone who receives that link can inspect and reuse
          the URL. Check it before sharing, especially when it contains an
          access token or other credential.
        </p>
      </PolicySection>

      <PolicySection title="Use Myna responsibly">
        <p>
          Do not use Myna to evade a media host’s access controls or to infringe
          copyright, violate another person’s privacy, or break laws that apply
          to you.
        </p>
        <p>
          Do not overload, disrupt, probe, or gain unauthorized access to Myna,
          Cloudflare, or a media host. Do not automate requests that overload a
          service or fetch files unrelated to playback.
        </p>
      </PolicySection>

      <PolicySection title="Third-party services and software">
        <p>
          Cloudflare hosts Myna and runs its media proxy. Media hosts provide
          the linked media. Those services operate under their own terms and
          privacy notices; Myna does not control their content or availability.
        </p>
        <p>
          Myna’s source code is released under the MIT License. Third-party
          software included in Myna may have separate license terms and notices.
        </p>
      </PolicySection>

      <PolicySection title="Playback and proxy limits">
        <p>
          Playback depends on the media source, your browser and device, and
          their format support. A link may stop working or may not play. Myna
          checks proxy destinations and applies a per-client request limit, so a
          proxy request can be rejected when it fails those checks or exceeds
          the limit.
        </p>
      </PolicySection>
    </PolicyPage>
  )
}
