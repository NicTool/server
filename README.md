# NicTool Server

NicTool is an open-source DNS management system. This package provides the **server** — a Node.js process that ties the NicTool DNS system together. It wears several hats:

## Bootstrap web configurator (index.js + html/)

- Starts an HTTPS server that serves a browser-based setup UI (html/configure.html, index.html, main.js).
- On first run it presents a config form; on POST to /nt/config it writes <config-dir>/etc/nictool.toml and flips configured = true so subsequent starts skip straight to running services.
- Small JSON control API for the UI: /nt/config, /nt/status, /nt/service, /nt/nameservers/status, /nt/check-path (validates/tests writable data paths).
- Serves static assets, with path-traversal guarding, including files from the installed @nictool/* packages under /nictool/.

## TLS auto-provisioning (bin/start.js)

- Discovers an existing cert (<hostname>.pem, localhost.pem, or legacy cert.pem+key.pem), parsing key/cert blocks out of a combined PEM.
- If none found, shells out to openssl to generate a self-signed cert and saves it.
- Picks a listen port: prefers 443 → falls back to 8443 → random free port.

## Process supervisor / launcher (bin/start.js)

- CLI entry (nictool-server -c <dir>), reads nictool.toml.
- Hosts the @nictool/api (Hapi) server in-process via hapiServer.inject() when api.mode = "local", patching the API's mysql.toml and setting NICTOOL_DATA_STORE* env vars from the store config. When api.mode = "remote", it reverse-proxies /api/* and /doc to the remote API instead.
- Handles SIGINT/SIGTERM to cleanly stop nameservers.

## Nameserver supervisor (lib/nameservers.js)

- Reads [[nameserver]] blocks and starts/stops one or more DNS engines from @nictool/dns-nameserver.
- Supports a native in-memory authoritative server plus export engines (bind, knot, nsd, powerdns, tinydns, maradns), wiring up the right Source (mysql / toml-directory), Publisher (memory / rfc1035 / tinydns-cdb / powerdns-db), Transport (noop / rsync / axfr / db-replication), and DNSSEC Signer per engine.

## PowerDNS co-process backend (bin/nt_powerdns.js)

- Standalone nt-powerdns binary implementing the PowerDNS pipe/co-process v1 protocol over stdin/stdout (a JS port of the legacy nt_powerdns.pl).
- Queries the NicTool MySQL schema directly (nt_zone, nt_zone_record, nt_nameserver, nt_zone_nameserver) to answer Q / SOA / NS / ANY / AXFR, with a TTL cache and reconnect-on-drop.

## Data model / config

- Everything is driven by nictool.toml ([store], [api], [[nameserver]]). Store can be MySQL or a TOML file directory (see data/zone.toml, data/zone_record.toml).
- Depends on the sibling workspace packages via file:../ links: @nictool/api, dns-nameserver, dns-zone, dns-resource-record.

## Prerequisites

- [Node.js](https://nodejs.org/) 18 or later
- `openssl` in `$PATH` (used to auto-generate self-signed TLS certs on first run)
- MySQL 8+ **or** a writable directory (for the TOML-based file store)

## Quickstart

### 1. Install

```sh
npm install -g nictool
```

Or run without installing:

```sh
npx nictool-server -c /var/lib/nictool
```

### 2. Create a data directory

```sh
mkdir -p /var/lib/nictool
```

### 3. Start the server

```sh
nictool-server -c /var/lib/nictool
```

On first run the server will:

1. Generate a self-signed TLS certificate for your hostname and save it to `/var/lib/nictool/etc/tls/`.
2. Open the **web configurator** at `https://<hostname>` (falls back to port `8443` if 443 is unavailable).

### 4. Complete setup in the browser

Open the URL printed to the console, fill in the configuration form, and click **Save**. The configurator writes `/var/lib/nictool/etc/nictool.toml` and starts the API automatically.

> **TLS warning** – The auto-generated certificate is self-signed. Accept the browser security warning for the initial setup, then replace it with a trusted certificate (see [TLS](#tls) below).

---

## Configuration

All settings live in `<config-dir>/etc/nictool.toml`. The file is created by the web configurator but can also be edited by hand. The server reads it on every start.

### Data store options

| `store.type` | Description |
|---|---|
| `mysql` | Production-ready; requires MySQL 8+ |
| `directory` | File-based TOML store; good for development |

#### MySQL example

```toml
[store]
type     = "mysql"
host     = "127.0.0.1"
port     = 3306
user     = "nictool"
password = "secret"
database = "nictool"
```

#### Directory (file) example

```toml
[store]
type = "directory"
path = "/var/lib/nictool/zones"
```

### API mode

The API can run **in-process** (default) or as a **remote** service:

```toml
[api]
mode = "local"   # "local" | "remote"
port = 3000      # only used for remote mode
host = ""        # only used for remote mode
```

---

## TLS

On startup the server looks for certificates in `<config-dir>/etc/tls/` in this order:

1. `<hostname>.pem` — combined PEM (private key + certificate chain)
2. `localhost.pem` — combined PEM, bound as `localhost`
3. `cert.pem` + `key.pem` — legacy split files

If none are found, a self-signed certificate is generated via `openssl` and saved as `<hostname>.pem`.

To use your own certificate, place a combined PEM file at:

```
<config-dir>/etc/tls/<hostname>.pem
```

---

## Nameservers

NicTool can serve DNS via a built-in native nameserver or by acting as a
co-process backend for PowerDNS. Both are configured in `nictool.toml` under
`[[nameserver]]` blocks.

### Native nameserver (in-memory)

The native engine is a pure-Node.js authoritative DNS server built on `dns2`.
It loads zone data into memory from the NicTool store at startup and keeps it
current through event-driven re-publishing (with a configurable cooldown).

Supports A, AAAA, CNAME, MX, NS, TXT, PTR, SRV, CAA, SOA over UDP and TCP.

```toml
[[nameserver]]
name   = "ns1.example.com."
engine = "native"

# Bind UDP and TCP on all interfaces, port 53.
[[nameserver.listen]]
address = "0.0.0.0"
port    = 53
proto   = "udp"

[[nameserver.listen]]
address = "0.0.0.0"
port    = 53
proto   = "tcp"

[nameserver.source]
type = "inherit"   # use the top-level [store]; or override with {type, host, ...}

[nameserver.publisher]
type = "memory"    # required for the native engine

[nameserver.transport]
type     = "noop"
interval = 0       # 0 = event-driven (publish on zone change); >0 = poll interval in seconds
cooldown = 5       # minimum seconds between consecutive publishes (burst protection)
```

Multiple native nameservers can run side-by-side by adding more `[[nameserver]]`
blocks — each gets its own UDP/TCP listener set.

### DNSSEC (native engine — future)

Attach an optional signing stage between the publisher and transport:

```toml
[nameserver.dnssec]
enabled   = false          # set true once MemorySigner is implemented
algorithm = "ECDSAP256SHA256"
keyset    = "/var/lib/nictool/dnssec/ns1"
nsec3     = true
```

---

### PowerDNS co-process backend

`nt-powerdns` (`bin/nt_powerdns.js`) implements the
[PowerDNS pipe/co-process backend](https://doc.powerdns.com/authoritative/backends/pipe.html)
protocol (v1). PowerDNS forks the script and communicates with it over
stdin/stdout; the script queries the NicTool MySQL database directly.

#### 1. Configure `pdns.conf`

```ini
launch=pipe
pipe-command=/usr/bin/nt-powerdns
pipe-timeout=2000

# If you need more than one backend process:
# pipe-command=/usr/bin/nt-powerdns --workers 4
```

Or, with the path from a local install:

```ini
launch=pipe
pipe-command=node /var/lib/nictool/bin/nt_powerdns.js
pipe-timeout=2000
```

#### 2. Set environment variables

```sh
export NT_PDNS_DB_HOST=127.0.0.1
export NT_PDNS_DB_PORT=3306
export NT_PDNS_DB_USER=nictool
export NT_PDNS_DB_PASS=secret        # required
export NT_PDNS_DB_NAME=nictool
export NT_PDNS_NS_ID=1               # nt_nameserver.nt_nameserver_id to serve
export NT_PDNS_CACHE_TTL=20          # seconds to cache query results
export NT_PDNS_LOG=0                 # set to 1 for verbose stderr logging
```

Set these in `/etc/default/pdns` (Debian/Ubuntu) so PowerDNS picks them up when it forks the co-process.

#### 3. Test manually

```sh
printf 'HELO\t1\nQ\texample.com\tIN\tSOA\t-1\t127.0.0.1\n' \
  | NT_PDNS_DB_PASS=secret node bin/nt_powerdns.js
```

Expected output:

```
OK      NicTool PowerDNS backend ready
DATA    example.com     IN      SOA     3600    1       ns1.example.com  hostmaster.example.com  2026010101  86400  7200  1209600  3600
END
```

#### Supported query types

| Type | Source |
|------|--------|
| A, AAAA, CNAME, MX, PTR, TXT, SRV | `nt_zone_record` |
| NS | `nt_nameserver` via `nt_zone_nameserver` |
| SOA | `nt_zone` (serial, refresh, retry, expire, ttl) |
| ANY | union of records + NS rows |
| AXFR | all records for the requested zone id |

---

## CLI reference

```
nictool-server -c <config-dir>

Options:
  -c, --config <dir>  Path to the NicTool data root (required).
```

---

## Development

```sh
# Install dependencies
npm install

# Run tests
npm test

# Run tests in watch mode
npm run watch

# Check formatting and linting
npm run format:check

# Auto-fix formatting and linting
npm run format
```

---

## License

BSD-3-Clause © [Matt Simerson](https://github.com/msimerson)
