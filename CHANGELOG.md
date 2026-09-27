# Stable release notes

## 0.2.3 — 2026-09-27

- Contain the local Mission chat bridge pending a supported workspace-scoped
  authentication handoff. Queries are not forwarded.
- Require explicit workspace/listener configuration and verify local workspace
  identity without following redirects or forwarding credentials.
- Preserve the stable five-tool interface and protocol negotiation behavior.

This branch reconstructs the exact 13 runtime/package files published to npm.
It deliberately contains no beta-only runtime modules. Tests, security guidance,
CI, and registry metadata are source-only and do not change the npm artifact.
The package's existing README and license are retained byte-for-byte to preserve
release reproducibility; the separately maintained beta source remains on main.
