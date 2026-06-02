# adt-rfc-bridge

Local HTTP→RFC bridge for SAP ADT REST. Lets HTTP-only ADT clients (e.g. [arc-1](https://github.com/marianfoo/arc-1)) reach RFC-only SAP systems by re-using vsp's `jco-proxy.jar`.

## How it works

```
arc-1 ──HTTP──▶ adt-rfc-bridge (Node, this repo) ──HTTP/JSON──▶ jco-proxy.jar ──JCo/RFC──▶ SAP
```

The bridge spawns vsp's `jco-proxy.jar` as a child process, waits for it to announce its port, then exposes a plain HTTP server. Every incoming request is wrapped into a `ProxyRequest` JSON envelope (`{method, uri, headers, body}`) and POSTed to `jco-proxy`'s `/rfc-proxy` endpoint. The proxy invokes SAP's `SADT_REST_RFC_ENDPOINT` function module over RFC and returns the full HTTP response as a `ProxyResponse` JSON envelope, which the bridge unwraps and returns to arc-1.

ADT cookies / CSRF / stateful session handling stay in arc-1 — the bridge is just an envelope translator.

## Prereqs

- Node 22+
- Java 21+ (Java 25 known to work; the proxy needs `--enable-native-access=ALL-UNNAMED`)
- vsp's ([mcp-abap-adt-vsp](https://github.com/marianfoo/mcp-abap-adt-vsp)) `jco-libs` directory present locally, containing:
  - `jco-proxy.jar`
  - `com.sap.conn.jco_*.jar` + platform-specific JCo jar
  - `libsapjco3.dylib` (or `.so`/`.dll`)

## Installation

```sh
# 1. Clone
git clone https://github.com/berndeplo/adt-rfc-bridge.git
cd adt-rfc-bridge

# 2. (No npm deps — the bridge is dependency-free. Node 22+ only.)

# 3. Configure
cp .env.example .env
# Edit .env:
#   - JCO_LIBS_DIR  → path to your local mcp-abap-adt-vsp/jco-libs
#   - SAP_*         → your SAP connection (message-server OR direct app-server) + credentials

# 4. Run
npm start
```

On startup you'll see:

```
[bridge] starting jco-proxy: java -cp ...
[jco-proxy] RFC Proxy Server started on port <X>
[bridge] jco-proxy ready on http://localhost:<X>
[bridge] listening on http://localhost:18080
[bridge] arc-1 connection: SAP_URL=http://localhost:18080 SAP_CLIENT=100 SAP_USER=YOURUSER
```

## Test

```sh
curl -s "http://localhost:18080/sap/bc/adt/discovery" -H 'Accept: application/atomsvc+xml' | head -30
```

If you get an Atom service-document XML back, the bridge works.

## Point arc-1 at it

```sh
cd ../arc-1
SAP_URL=http://localhost:18080 \
SAP_USER=YOURUSER \
SAP_PASSWORD=anything-nonempty \
SAP_CLIENT=100 \
node bin/arc1-cli.js search "Z*"
```

The bridge's password is the one used by JCo for the actual SAP connection (set in `.env`). arc-1's `SAP_PASSWORD` here is unused for the upstream auth — but it must be non-empty so arc-1's config validation passes. The bridge ignores arc-1's `Authorization` header and the real RFC auth happens inside jco-proxy.

In `.mcp.json` for Claude Desktop / Cursor / etc:

```json
{
  "mcpServers": {
    "arc-1-via-rfc": {
      "command": "npx",
      "args": ["-y", "arc-1",
               "--url", "http://localhost:18080",
               "--user", "YOURUSER", "--password", "dummy",
               "--client", "100",
               "--allow-writes",
               "--allowed-packages", "Z*,Y*,$TMP"]
    }
  }
}
```

(Start the bridge first; arc-1 will fail with `ECONNREFUSED` if the bridge isn't running.)

## Known limitations

- **Bodies are JSON strings** — anything binary may need explicit base64 handling (most ADT calls are XML, so usually fine).
- **Multi-value headers collapse** — jco-proxy uses a flat `Map<String,String>`. Multiple `Set-Cookie` lines might be lost.
- **Endpoints unsupported by `SADT_REST_RFC_ENDPOINT`** — most things work; debugger WebSocket and a few real-time endpoints don't.
- **No TLS** — bridge listens on plain HTTP, bound to `127.0.0.1` only. Don't expose it on a network interface.

## Why this exists

Some SAP systems are reachable only via RFC/SNC (no HTTP web dispatcher exposed to the corporate network). [arc-1](https://github.com/marianfoo/arc-1) is HTTP-only by design. vsp ([mcp-abap-adt-vsp](https://github.com/marianfoo/mcp-abap-adt-vsp)) ships `jco-proxy.jar` for exactly this case. This bridge re-uses that proxy so the broader arc-1 toolchain works against RFC-only systems.

## ABAP MCP ecosystem

This bridge is a small adapter that sits in front of the broader ABAP-on-MCP toolchain. Related projects:

| Project | Author | Role |
|---------|--------|------|
| [arc-1](https://github.com/marianfoo/arc-1) | Marian Zeis | Production-grade MCP server connecting AI assistants to SAP via ADT REST — the primary client this bridge serves |
| [mcp-abap-adt-vsp](https://github.com/marianfoo/mcp-abap-adt-vsp) | Marian Zeis | Ships the `jco-proxy.jar` that this bridge re-uses to reach RFC-only systems |
| [abap-adt-api](https://github.com/marcellourbani/abap-adt-api) | Marcello Urbani | TypeScript ADT library and definitive API reference |
| [mcp-abap-adt](https://github.com/mario-andreschak/mcp-abap-adt) | Mario Andreschak | First MCP server for ABAP ADT |
| [vibing-steampunk](https://github.com/oisee/vibing-steampunk) | oisee | Original Go MCP server — arc-1's starting point |
| [abaplint](https://github.com/abaplint/abaplint) | Lars Hvam | ABAP parser/linter (used via `@abaplint/core`) |

## License

MIT
