import { SITE_ORIGIN } from "#/lib/seo"

const POLICY_PAGES = {
  privacy: {
    title: "Privacy policy | Myna",
    description:
      "How Myna handles media links, browser storage, and requests made through its browser media player.",
    path: "/privacy",
  },
  cookies: {
    title: "Cookies and browser storage | Myna",
    description:
      "How Myna uses browser storage and what is known about cookies in the player.",
    path: "/cookies",
  },
  terms: {
    title: "Terms of use | Myna",
    description:
      "Rules for using the Myna browser media player and its media proxy.",
    path: "/terms",
  },
  usage: {
    title: "Usage policy | Myna",
    description: "Rules for using Myna and its media proxy responsibly.",
    path: "/usage",
  },
} as const

export type PolicyPageKey = keyof typeof POLICY_PAGES

export function policyHead(key: PolicyPageKey) {
  const policy = POLICY_PAGES[key]

  return {
    meta: [
      { title: policy.title },
      { name: "description", content: policy.description },
    ],
    links: [{ rel: "canonical", href: `${SITE_ORIGIN}${policy.path}` }],
  }
}
