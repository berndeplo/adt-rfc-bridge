# adt-rfc-bridge

Local HTTP→RFC bridge for SAP ADT REST. Lets HTTP-only ADT clients (e.g. [arc-1](https://github.com/marianfoo/arc-1)) reach RFC-only SAP systems.

## How it works

```
arc-1 ──HTTP──▶ adt-rfc-bridge (Node, this repo) ──HTTP/JSON──▶ jco-proxy.jar ──JCo/RFC──▶ SAP
```

The bridge spawns `jco-proxy.jar` as a child process, waits for it to announce its port, then exposes a plain HTTP server. Every incoming request is wrapped into a `ProxyRequest` JSON envelope (`{method, uri, headers, body}`) and POSTed to `jco-proxy`'s `/rfc-proxy` endpoint. The proxy invokes SAP's `SADT_REST_RFC_ENDPOINT` function module over RFC and returns the full HTTP response as a `ProxyResponse` JSON envelope, which the bridge unwraps and returns to arc-1.

ADT cookies / CSRF / stateful session handling stay in arc-1 — the bridge is just an envelope translator.

## Prereqs

- Node 22+ (the bridge itself is dependency-free)
- Java 21+ runtime (Java 25 known to work; the proxy needs `--enable-native-access=ALL-UNNAMED`)
- Eclipse with ABAP Development Tools (ADT) installed locally — this is where
  `npm run setup` sources the SAP JCo libraries from (see below)
- Platform: `npm run setup` runs on macOS, Linux, and Windows, but the bridge
  runtime itself currently targets macOS/Linux (it uses `pgrep` and
  `LD_LIBRARY_PATH`/`DYLD_LIBRARY_PATH`)

## Installation

```sh
# 1. Clone
git clone https://github.com/berndeplo/adt-rfc-bridge.git
cd adt-rfc-bridge

# 2. Detect + copy the SAP JCo libraries from your Eclipse ADT install
npm run setup

# 3. Configure SAP connection
#    (setup already created .env from .env.example)
#    Edit .env: set SAP host/user/password. JCO_LIBS_DIR already points at ./jco-libs.

# 4. Run
npm start
```

`npm run setup` searches your Eclipse install (honoring `ECLIPSE_HOME` if set),
finds `com.sap.conn.jco_*.jar` plus the platform-native fragment for your OS, and
copies both into `./jco-libs/`. No npm dependencies are installed — the bridge
runs on Node built-ins only.

### Switching SAP clients

`npm start` loads `.env`. An optional argument selects `.env.<suffix>` instead:

```sh
npm start        # → .env
npm start 020    # → .env.020
```

The suffix is by convention the client number, but the client actually used is
whatever `SAP_CLIENT` that file sets. Create the second file by copying `.env`,
changing `SAP_CLIENT`, and setting the password for that client (user master
records are per client, so it may differ).

Keep `BRIDGE_PORT` identical — sharing the port is what makes this a *switch*
rather than two bridges. Start a second one and it reports the running bridge
instead of competing for the port: same client, it tails that bridge's log;
different client, it refuses to start and tells you which pid to stop. Give the
files different ports and you get two independent bridges instead, but note that
starting one currently reaps the other's `jco-proxy` sidecar. `.gitignore` covers
`.env.*`, so per-client files stay out of git.

Always quote the password — `SAP_PASSWORD="..."` — because Node's env-file
parser treats an unquoted `#` as a comment and silently truncates the value,
which SAP then reports as `Name or password is incorrect (repeat logon)`.

Note that the ABAP repository is cross-client: classes, programs, DDIC and CDS
objects are the same in every client *of that system*. Only client-dependent
data (application tables, client-dependent Customizing) and your authorizations
differ. A second client is therefore not a code sandbox — activating a class in
one client changes it for all of them — and because source looks identical
either way, there is no visual cue telling you which client you are in.

### How the JCo libraries are obtained

The SAP JCo libraries (`com.sap.conn.jco_*.jar` and the native `libsapjco3.*`
inside the platform fragment) are **licensed SAP binaries and are not
redistributable**, so this repo does not ship them. They are, however, bundled
inside every Eclipse ADT installation's `plugins/` directory (and downloadable
from SAP's "SAP Java Connector" area with an S-user). `npm run setup` copies them
out of your local ADT install into `./jco-libs/` (which is gitignored). The
correct fragment for your platform is selected automatically, and setup also
extracts the native `libsapjco3.*` out of that jar as a loose file — the JVM's
native loader has to find it on `java.library.path`, otherwise the proxy dies
with `UnsatisfiedLinkError: no sapjco3 in java.library.path`. Either way there
is no manual `.dylib`/`.so`/`.dll` step for you.

If setup can't find them, install Eclipse ADT or set `ECLIPSE_HOME` to your
Eclipse directory and re-run `npm run setup`.

### About jco-proxy.jar

`jco-proxy.jar` (and its source in `jco-proxy/`) is bundled in this repo. It is
original MIT-licensed code that wraps SAP's `SADT_REST_RFC_ENDPOINT` over JCo;
its `sapjco3` dependency is `provided`, so the jar contains **no** licensed SAP
bytes. To rebuild it, see `jco-proxy/README.md`.

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

Some SAP systems are reachable only via RFC/SNC (no HTTP web dispatcher exposed
to the corporate network). [arc-1](https://github.com/marianfoo/arc-1) is
HTTP-only by design. This bridge runs a small JCo sidecar (`jco-proxy.jar`) so
the broader arc-1 toolchain works against RFC-only systems.

## ABAP MCP ecosystem

This bridge is a small adapter that sits in front of the broader ABAP-on-MCP toolchain. Related projects:

| Project | Author | Role |
|---------|--------|------|
| [arc-1](https://github.com/marianfoo/arc-1) | Marian Zeis | Production-grade MCP server connecting AI assistants to SAP via ADT REST — the primary client this bridge serves |
| [abap-adt-api](https://github.com/marcellourbani/abap-adt-api) | Marcello Urbani | TypeScript ADT library and definitive API reference |
| [mcp-abap-adt](https://github.com/mario-andreschak/mcp-abap-adt) | Mario Andreschak | First MCP server for ABAP ADT |
| [vibing-steampunk](https://github.com/oisee/vibing-steampunk) | oisee | Original Go MCP server — arc-1's starting point |
| [abaplint](https://github.com/abaplint/abaplint) | Lars Hvam | ABAP parser/linter (used via `@abaplint/core`) |

## License

MIT
