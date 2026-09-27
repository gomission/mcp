# Security

Report suspected vulnerabilities privately to missionexecutionlayer@gmail.com. Please include the affected version and a reproduction using synthetic data, without credentials or personal data.

## September 2, 2026 security fixes

The fixes released in `@gomission/mcp@0.2.2` and `@gomission/mcp@0.3.0-beta.2` address:

- Compound read/write tool names bypassing consequential-action holds.
- `get_receipt` reading JSON files outside the receipts directory in standalone and proxy modes.

Use stable `0.2.2` or beta `0.3.0-beta.2` or later releases containing these fixes. This source update synchronizes the public repository with the published beta fixes and adds regression coverage.

Credit: **Syed Anas Mohiuddin, Independent Researcher, Maintainer of mcp-safeguard.**
