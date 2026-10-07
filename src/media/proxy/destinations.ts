// Destination validation for the media proxy. Blocks non-HTTPS targets and
// every hostname or IP literal that could point at private or link-local
// infrastructure. Called for the initial destination and every redirect hop.

const BLOCKED_HOSTNAME_SUFFIXES = ["localhost", "local", "internal"] as const

function isPrivateIPv4(host: string): boolean {
  const parts = host.split(".")

  if (parts.length !== 4) {
    return false
  }

  const octets: number[] = []

  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return false
    }

    const value = Number(part)

    if (value > 255) {
      return false
    }

    octets.push(value)
  }

  const [first, second] = octets

  // 0/8 (this-host), 10/8 (private), 100.64/10 (CGNAT), 127/8 (loopback),
  // 169.254/16 (link-local incl. cloud metadata), 172.16/12 (private),
  // 192.0.0/24 (IETF protocol assignments), 192.168/16 (private),
  // 198.18/15 (benchmarking).
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19))
  )
}

function expandIPv6(host: string): string[] {
  // Expand "::" so each group is comparable; returns [] for invalid input.
  const halves = host.split("::")

  if (halves.length > 2) {
    return []
  }

  const left = halves[0] === "" ? [] : halves[0].split(":")

  const right =
    halves.length === 2 && halves[1] === ""
      ? []
      : (halves.at(-1)?.split(":") ?? [])

  const missing = 8 - left.length - (halves.length === 2 ? right.length : 0)

  if (halves.length === 1) {
    return left.length === 8 ? left : []
  }

  if (missing < 0) {
    return []
  }

  return [...left, ...Array<string>(missing).fill("0"), ...right]
}

function isPrivateIPv6(host: string): boolean {
  if (host.includes("%")) {
    // Zone index (fe80::1%eth0) is always link-local scoped.
    return host.toLowerCase().startsWith("fe80:")
  }

  const groups = expandIPv6(host)

  if (groups.length !== 8) {
    return false
  }

  const [
    firstGroup,
    secondGroup,
    thirdGroup,
    fourthGroup,
    fifthGroup,
    sixthGroup,
    seventhGroup,
    eighthGroup,
  ] = groups

  const leadingGroups = [
    firstGroup,
    secondGroup,
    thirdGroup,
    fourthGroup,
    fifthGroup,
  ]

  // URL hostnames normalize IPv4-mapped addresses to hex groups
  // (::ffff:a01:203 for 10.1.2.3), so decode the mapped IPv4 from the
  // final two groups and apply the IPv4 rules to it.
  if (
    leadingGroups.every((group) => group === "0") &&
    sixthGroup?.toLowerCase() === "ffff"
  ) {
    const high = Number.parseInt(seventhGroup ?? "0", 16)
    const low = Number.parseInt(eighthGroup ?? "0", 16)

    return isPrivateIPv4(
      `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`
    )
  }

  // ::/128 unspecified and ::1/128 loopback carry zeros in every group but
  // the last; the loopback's final group is 1.
  if (
    [...leadingGroups, sixthGroup, seventhGroup].every((group) => group === "0")
  ) {
    return Number.parseInt(eighthGroup ?? "0", 16) <= 1
  }

  const first = Number.parseInt(firstGroup ?? "0", 16)

  // fc00::/7 unique local, fe80::/10 link-local, ff00::/8 multicast.
  return (
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 ||
    (first & 0xff00) === 0xff00
  )
}

// Returns a rejection reason, or null when the destination is allowed.
export function rejectDestination(url: URL): string | null {
  if (url.protocol !== "https:") {
    return "only https destinations are allowed"
  }

  if (url.port !== "" && url.port !== "443") {
    return "non-standard ports are not allowed"
  }

  const host = url.hostname.toLowerCase().replaceAll(/^\[|\]$/g, "")

  if (host === "") {
    return "empty hostname"
  }

  for (const suffix of BLOCKED_HOSTNAME_SUFFIXES) {
    if (host === suffix || host.endsWith(`.${suffix}`)) {
      return `hostnames under .${suffix} are not allowed`
    }
  }

  if (host.includes(":")) {
    return isPrivateIPv6(host)
      ? "private IPv6 destinations are not allowed"
      : null
  }

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    return isPrivateIPv4(host)
      ? "private IPv4 destinations are not allowed"
      : null
  }

  return null
}
