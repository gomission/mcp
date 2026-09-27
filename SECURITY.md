# Security reporting

Please report potential vulnerabilities privately through this repository’s GitHub security advisory form or email mission@gomission.io. Include affected versions, impact and a minimal reproduction using synthetic data. Do not include live credentials, customer data or private workspace exports in public issues.

An approval recorded by a client or model is not provider execution authority. Follow the documented deployment boundary, isolate each workspace, and apply reviewed security updates. Reported issues and releases do not constitute a security certification.

## Reported classification and receipt fixes

The fixes published in `@gomission/mcp@0.2.2` and `@gomission/mcp@0.3.0-beta.2` address:

- Compound read/write tool names bypassing consequential-action holds.
- `get_receipt` reading JSON files outside the receipts directory in standalone and proxy modes.

Use those patched releases or later versions containing these fixes. Regression coverage includes compound names, ordinary reads, traversal, symbolic links, and standalone receipt behavior.

Credit: **Syed Anas Mohiuddin, Independent Researcher, Maintainer of mcp-safeguard.**
