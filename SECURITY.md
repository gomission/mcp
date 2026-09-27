# Security reporting

Please report potential vulnerabilities privately through this repository’s GitHub security advisory form or email mission@gomission.io. Include affected versions, impact and a minimal reproduction using synthetic data. Do not include live credentials, customer data or private workspace exports in public issues.

An approval recorded by a client or model is not provider execution authority. Follow the documented deployment boundary, isolate each workspace, and apply reviewed security updates. Reported issues and releases do not constitute a security certification.

## Reported classification and receipt fixes

The fixes published in `@gomission/mcp@0.2.2` and `@gomission/mcp@0.3.0-beta.2` address:

- Compound read/write tool names bypassing consequential-action holds.
- `get_receipt` reading JSON files outside the receipts directory in standalone and proxy modes.

For current installations, use **stable `0.2.3`** or **beta `0.3.0-beta.3`**. These releases retain both fixes and include subsequent workspace-boundary hardening. `0.2.2` and `0.3.0-beta.2` remain the first patched versions for the two issues above.

Do not deploy stable `0.1.0` through `0.2.1`, or `0.3.0-beta.1`: those versions contain the receipt-access vulnerability. The compound-name classification issue additionally affects the proxy in `0.2.0`, `0.2.1`, and `0.3.0-beta.1`.

Current source is available on `main` and in the [stable release](https://github.com/gomission/mcp/releases/tag/v0.2.3) and [beta release](https://github.com/gomission/mcp/releases/tag/v0.3.0-beta.3). Historical commits and tags are retained for reproducibility; their continued availability does not mean they are supported or patched. Existing pinned installations must upgrade explicitly.

Regression coverage includes compound names, ordinary reads, traversal, symbolic links, and standalone receipt behavior. CI runs these checks on pushes and pull requests.

Credit: **Syed Anas Mohiuddin, Independent Researcher, Maintainer of mcp-safeguard.**
