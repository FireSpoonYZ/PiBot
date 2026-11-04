# e-launcher-host

Standalone Rust supervisor and pairing CLI for the bundled `e-launcher` Host service.

## Subcommands

- `e-launcher-host run` — Foreground windowless supervisor that locks `HOST_HOME/launcher.lock`, spawns the bundled Node runtime (`e-launcher-client-node` + `host-runtime/host-core/host-service-cli.js serve`), rotates `HOST_HOME/logs/host.log` at 10 MiB, and restarts the Host with exponential backoff on unexpected exits.
- `e-launcher-host start | stop | restart | status` — Background service lifecycle control (delegates to `systemctl --user` on Linux when `e-launcher-host.service` is installed).
- `e-launcher-host enable | disable` — Login autostart management (`HKCU\Software\Microsoft\Windows\CurrentVersion\Run` on Windows; `systemctl --user enable/disable e-launcher-host.service` + `loginctl enable-linger` on Linux).
- `e-launcher-host pair --center-url <url> [--name <displayName>] [--port <port>] [--data-root <path>] [--center-ca-file <path>] [--force]` — Logs in to Center as owner (password read from `E_LAUNCHER_OWNER_PASSWORD` or first line of stdin), registers the local Host via `POST /api/devices`, writes `config.json` and `secrets.env`, enables autostart, and starts the service.
- `e-launcher-host adopt --center-url <url> --device-id <id> [--name <displayName>] [--port <port>] [--data-root <path>] [--center-ca-file <path>]` — Adopts an existing registered device (token read from `E_LAUNCHER_RELAY_TOKEN` or first line of stdin).
