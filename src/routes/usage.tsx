import { createFileRoute } from "@tanstack/react-router"

import { PolicyPage, PolicySection } from "#/components/policy-page"
import { policyHead } from "#/lib/policies"

export const Route = createFileRoute("/usage")({
  head: () => policyHead("usage"),
  component: UsagePage,
})

function UsagePage() {
  return (
    <PolicyPage
      title="Usage policy"
      introduction="Use Myna with media links and hosts you are authorized to access. These rules cover the browser media player and its proxy."
    >
      <PolicySection title="Use media you are authorized to access">
        <p>
          You must have permission to access the media URL you enter. Do not use
          Myna to obtain content unlawfully, evade a host’s access controls, or
          defeat restrictions that apply to the source.
        </p>
        <p>
          You are responsible for the URL and the media it identifies. A URL may
          contain a temporary token or other credential. Do not share it unless
          you intend the recipient to inspect and reuse it.
        </p>
      </PolicySection>

      <PolicySection title="Protect connected services">
        <p>
          Do not use Myna to overload, disrupt, probe, or gain unauthorized
          access to Myna, Cloudflare, or a media host. Do not automate requests
          that overload a service or fetch files unrelated to playback.
        </p>
        <p>
          Myna checks proxy destinations and applies a per-client request limit.
          The proxy may reject requests that fail destination checks or exceed
          that limit.
        </p>
      </PolicySection>

      <PolicySection title="Respect media and other people’s rights">
        <p>
          Do not use Myna to infringe copyright, violate another person’s
          privacy, or distribute a media URL without authority. Follow the
          policies and terms of the media host as well as rules that apply to
          the content you access.
        </p>
      </PolicySection>

      <PolicySection title="Limits and reporting">
        <p>
          Myna has no account moderation, in-app reporting, or appeal workflow.
          A rejected proxy request does not have a separate review process in
          the app.
        </p>
        <p>
          For a product issue, visit the{" "}
          <a
            href="https://github.com/DG02002/myna"
            target="_blank"
            rel="noreferrer"
            className="text-white/80 underline underline-offset-4 hover:text-white"
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
