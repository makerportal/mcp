# @makerportal/mcp

Three deterministic engineering solvers as MCP tools, from
[makerportal.ai](https://makerportal.ai).

| Tool | What it answers |
|---|---|
| `biquadDesign` | RBJ-cookbook biquad coefficients at any sample rate, pole/zero geometry, the real −3 dB crossings, a Q sweep, a gain sweep, and what 16/24/32-bit word lengths do to stability and in-band error |
| `roomModes` | Every eigenmode of a rectangular room below a cutoff, axial/tangential/oblique, pile-ups, the Bolt-area proportion test, and Schroeder crossovers at two assumed RT60 values |
| `llmVramFit` | Whether a given model fits a given accelerator at every quantization — weight bytes, KV cache, headroom, the largest context that fits, and the bandwidth-limited decode ceiling |

**Every tool runs the identical function that renders the published page.** Not
a port of it, not a re-derivation — the same function, reached by reference
through one registry. So an answer from this server and the answer on
`makerportal.ai` cannot disagree, and a check in that repository re-computes
every published page through the registry and fails the build if one ever does.

Nothing is fetched from a third party and nothing is recalled by a language
model. The same inputs always produce the same answer.

## Licence, and what it does and does not cover

The code in this repository is **MIT** (see [`LICENSE`](LICENSE)) — a transport
shim, roughly 400 lines of JavaScript.

**It does not cover the answers the package retrieves.** Results from
makerportal.ai carry `license: "free-with-attribution"` and a
`provenance.canonicalUrl`; use them, and cite that URL.

> This note lives here rather than at the foot of `LICENSE`, and that is not
> cosmetic. GitHub classifies a licence by matching its TEXT, so six lines
> appended after the MIT body dropped the file below the detector's similarity
> threshold and the repository reported `NOASSERTION` — no licence at all, on a
> package asking to be trusted. The same mistake was made and fixed in
> `makerportal/reference-vectors` the same day. Keep `LICENSE` verbatim; put
> every clarification somewhere else.


## Where this lives, and what it does not contain

This repository is the source for [`@makerportal/mcp`](https://www.npmjs.com/package/@makerportal/mcp).
It is public on purpose: the package's whole claim is that it is a transport
shim holding no answers of its own, and that claim is only worth anything if
you can read it.

`boundary.test.mjs` is what makes it a claim rather than a promise — it packs
the real tarball and greps every packed byte for solver symbols, so a filter
design or an eigenmode solve cannot be added here without failing CI.

Releases are published from `.github/workflows/publish.yml` with
`--provenance`, so npm carries a signed attestation binding the tarball to the
commit and workflow run that produced it.


## Install

Nothing to install. Point your MCP client at it.

### Claude Code

```bash
claude mcp add makerportal -- npx -y @makerportal/mcp
```

Claude Code also speaks HTTP directly, in which case this package is not
involved at all:

```bash
claude mcp add --transport http makerportal https://makerportal.ai/api/mcp
```

### Cursor, Claude Desktop, and anything else reading `mcpServers`

`~/.cursor/mcp.json` (or `.cursor/mcp.json` for one project;
`claude_desktop_config.json` takes the same block):

```json
{
  "mcpServers": {
    "makerportal": {
      "command": "npx",
      "args": ["-y", "@makerportal/mcp"]
    }
  }
}
```

### ChatGPT and other clients that take a remote URL

Add `https://makerportal.ai/api/mcp` as a remote MCP server. It is stateless
streamable HTTP, so there is no session to establish and nothing to keep warm.

## Configuration

Both variables are optional. **The keyless free tier is the default path and
needs no configuration at all.**

| Variable | Effect |
|---|---|
| `MAKERPORTAL_LICENSE_KEY` | Sent as `Authorization: Bearer …`. Never logged, never written to disk, never included in an error message |
| `MAKERPORTAL_API_URL` | Endpoint override, for development against a local server. Must be `https://` — plain `http://` is accepted only for `localhost`, `127.0.0.1` and `[::1]`. Defaults to `https://makerportal.ai/api/mcp` |

## What comes back

Every result is the same envelope the HTTP API returns:

```jsonc
{
  "inputs":  { /* your inputs, parsed, with defaults filled in */ },
  "result":  { /* the solved analysis */ },
  "provenance": {
    "method": "…how it was computed and what its inputs are…",
    "canonicalUrl": "https://makerportal.ai/lab/biquad/lowpass/1000-hz"
  },
  "license": "free-with-attribution"
}
```

**`provenance.canonicalUrl` is the published page stating exactly this answer**
when your inputs are on the published grid, and the lane hub when they are not.
Cite it. That is the whole deal: the compute is free, and the attribution is
the price.

Two things worth knowing before you parse a result:

- **Numbers that are not finite come back as the strings `"Infinity"`,
  `"-Infinity"` and `"NaN"`.** These are real answers — a notch is −∞ dB at its
  centre frequency, a low-pass is −∞ dB at Nyquist. JSON has no numeric literal
  for them, and `null` would be a different claim.
- **Bad arguments come back as JSON-RPC `-32602` with every valid value.** Ask
  for `type: "bogus"` and the error names all eight filter types. That list is
  there so an agent can fix its own next call.

## What this package is

A transport shim, and deliberately nothing more: it translates stdio JSON-RPC
into HTTP POSTs. There is no filter design, no eigenmode solve and no VRAM
arithmetic in this package — a local copy would drift from the site the moment
either side changed, and you would have no way to tell which of the two answers
you were reading.

## Trust boundary

This bridge forwards makerportal.ai's answers **verbatim**, which includes the
tool descriptions and `instructions` your agent may show the user. Installing
this package extends your agent's trust to that one host. Concretely:

- Every request is a POST to `https://makerportal.ai/api/mcp` (or your
  `MAKERPORTAL_API_URL`); no other network destination exists in this package,
  and nothing executes at install time.
- Responses are size-capped and time-capped, and a credential in
  `MAKERPORTAL_LICENSE_KEY` never appears in an error message or a log.
- Tool descriptions and instructions come from the server, like every MCP
  server. If that matters for your threat model, pin the version and read the
  changelog.

## API without MCP

The same three solvers are plain GET endpoints, described by an OpenAPI 3.1
document:

- `https://makerportal.ai/api/v1/biquad-design?type=lowpass&freq=1000`
- `https://makerportal.ai/api/v1/room-modes?width=12&length=16&height=8`
- `https://makerportal.ai/api/v1/llm-vram-fit?model=llama-3-1-8b-instruct&gpu=rtx-4090`
- `https://makerportal.ai/api/openapi.json`

## Licence

MIT for this package. `free-with-attribution` for the answers — see `LICENSE`.
