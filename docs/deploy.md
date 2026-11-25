# Deploying

How to run Lichess Kibitzer as a systemd service. The host, `proxy-dmz` (Caddy + CrowdSec), DNS for
`analysis.ccrl.live` and the Berserk build are managed in homelab, not here (see the PRD's *Deployment
requirements*, kept outside this repo). This doc says what the app needs from them.

## What the app needs

- **Node** `^20.19.0 || >=22.12.0` and npm (check `node -v`).
- **A UCI engine binary** readable and executable by the `kibitzer` user, outside `/home` (the unit sets
  `ProtectHome=true`). Default: Berserk at `/usr/local/bin/berserk`.
- **Memory** for the engine defaults: Hash=1024 MB plus Node's own footprint (sizing is homelab's). One engine
  process at a time, none when Idle.
- **Outbound HTTPS** to `lichess.org` (broadcast API and PGN stream).
- **Inbound** TCP on `PORT` (default 8080) from the reverse proxy only. The app binds all interfaces.

## Install

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin kibitzer
sudo mkdir /opt/lichess-kibitzer && sudo chown "$USER": /opt/lichess-kibitzer
git clone https://github.com/jhonnold/lichess-kibitzer.git /opt/lichess-kibitzer
cd /opt/lichess-kibitzer
npm ci            # dev dependencies are needed to build
npm run build     # vite → build/public, tsc → build/src

sudo install -m 600 -o root -g root .env.example .env
sudoedit .env     # set ADMIN_PASSWORD before the first start
sudo cp deploy/lichess-kibitzer.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now lichess-kibitzer
```

The checkout is owned by the deploy user and only read by `kibitzer`. `.env` is root-only: systemd reads it
before dropping privileges. If `node` is not `/usr/bin/node` (`command -v node`), edit `ExecStart`; it must not live under `/home`
(e.g. nvm), which `ProtectHome=true` hides.

## Environment

All set in `/opt/lichess-kibitzer/.env` (template: [`.env.example`](../.env.example)). The unit adds
`NODE_ENV=production`.

| Var | Default | Notes |
|-----|---------|-------|
| `PORT` | `8080` | HTTP port. |
| `ADMIN_PASSWORD` | unset | Unset or empty refuses every login. |
| `DATA_FILE` | `data/state.json` (relative to the working dir) | Set to `/var/lib/lichess-kibitzer/state.json`: the only writable dir under `ProtectSystem=strict`. |
| `DEFAULT_ENGINE` | `berserk` (PATH lookup) | Engine path prefilled on the Admin page, with Threads=1, Hash=1024. |

## Service

```bash
systemctl status lichess-kibitzer
journalctl -u lichess-kibitzer -f
curl -s localhost:8080/healthz          # {"ok":true}
```

- `systemctl stop`/`restart` sends SIGTERM: SSE clients are dropped, the engine gets `quit` (SIGKILL after 1 s)
  and the state file is flushed. A live Board resumes on the next start; positions missed while down are
  Backfilled and excluded from accuracy.
- A restart logs Admins out (the cookie key is per process).
- `Restart=on-failure` restarts a crash after 5 s.

## Reverse proxy (Caddy)

```caddyfile
analysis.ccrl.live {
	reverse_proxy <kibitzer-host>:8080
}
```

- **SSE** (`/api/events`): Caddy flushes `text/event-stream` responses immediately, and the app also sends
  `Cache-Control: no-cache` and `X-Accel-Buffering: no`. Add `flush_interval -1` inside `reverse_proxy` only
  if events arrive in bursts. Nothing in front of Caddy may buffer or time out long-lived responses.
- **Trust proxy**: the app trusts `X-Forwarded-*` only from loopback and private addresses
  (`trust proxy = 'loopback, uniquelocal'`). Caddy sets `X-Forwarded-Proto` by default; with the proxy on a
  private address, `req.secure` is true and the admin cookie is `Secure`. If the proxy reaches the app from a
  public address, the cookie loses `Secure`.
- The Admin page (`/#/admin`, API under `/api/admin/`) is public behind its password.

## Update

The state file lives in `/var/lib`, so a pull never touches it.

```bash
cd /opt/lichess-kibitzer
git pull
npm ci
npm run build
sudo systemctl restart lichess-kibitzer
```

If `deploy/lichess-kibitzer.service` changed: `sudo cp` it again and `sudo systemctl daemon-reload` before
the restart. If `.env.example` gained a var, add it to `.env`.

### Updating Berserk

The engine is spawned when a Board is picked or resumed, so a new binary takes effect on the next spawn.
After building Berserk from current `main` (homelab), install it and restart:

```bash
sudo install -m 755 berserk /usr/local/bin/berserk   # replaces the file; a running engine keeps the old one
sudo systemctl restart lichess-kibitzer               # resume spawns the new binary
```
