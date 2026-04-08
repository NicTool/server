# NicTool Server

NicTool is an open-source DNS management system. This package provides the **server** — a Node.js process that serves the web-based configurator UI, hosts the REST API (in-process or as a proxy), and manages TLS automatically.

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
