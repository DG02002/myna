# Playloom

Playloom is a browser media player. Paste a direct media URL and it plays
immediately — MP4, WebM, MKV, HEVC, HLS, multi-track audio. The browser's
native pipeline always plays first; custom decoding (WebCodecs + focused WASM
codecs) extends it only for what the browser cannot do: E-AC-3/AC-3/DTS audio,
track switching, and CORS-blocked byte access. Decoding happens in the client;
Cloudflare Workers serve the app and proxy byte ranges.

Playloom plays everything the browser can, plus what Mediabunny, WebCodecs,
and WASM extend — not literally everything. Known gaps stated honestly:
TrueHD, VC-1, MPEG-2 video, some Dolby Vision profiles, and HEVC without
platform hardware support.

## Documentation

- [Local development](docs/internals/development.md)
- [Coding standards](docs/internals/coding-standards.md)
- [Security policy](SECURITY.md)

## Contributing

Building from source or thinking about a contribution? Read
[CONTRIBUTING.md](CONTRIBUTING.md) before reporting a bug or opening a PR.

## License

Not yet decided.
