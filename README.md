# @gomission/mcp

[![Mission MCP Glama score](https://glama.ai/mcp/servers/gomission/mcp/badges/score.svg)](https://glama.ai/mcp/servers/gomission/mcp/score)

Mission’s open MCP interception adapter for exact-action authority.

It has one narrow job: sit before a wrapped MCP provider, classify a proposed
tool call, and hold consequential calls with an immutable Trust Graduation
action binding. Low-risk calls may pass through. A chat message saying
“approve” is never treated as authority.

Status: experimental beta. Apache-2.0. Zero runtime dependencies.

## Prove the boundary first

Requirements: Node.js 20 or newer.

```bash
npx -y @gomission/mcp@beta demo
```

The command uses a fake email provider and prints one machine-readable
`DEMO_RESULT`. It proves that:

- the consequential provider function was called zero times;
- the hold contains an exact action and input hash;
- changing the reviewed input changes the commitment;
- chat text grants no execution authority.

This proves interception, not completed authorization or production adoption.
The portable grant/replay proof lives in `@trust-graduation/core`:

```bash
npx -y @trust-graduation/core@beta demo
```

## The three primitives

| Primitive | Responsibility | Portable object |
| --- | --- | --- |
| Mission Gate | Decide before a provider effect | action decision |
| Trust Profile | Track earned authority per principal and action class | evidence profile |
| Mission Key | Authorize one exact action until expiry or revocation | single-use grant |

The MCP adapter implements the pre-provider hold. It does not mint a trusted
Mission Key and it cannot resume a held call. A trusted approval host and
executor must validate and atomically consume the matching key. The
experimental A2A continuation is published at:

`https://trustgraduation.org/extensions/a2a/action-authorization/v1`

## MCP Hold to Exact Provider Execution

The package root exposes the stable, zero-dependency binding bridge used by an
external approval host and executor:

```js
import { providerActionFromMcpBinding } from "@gomission/mcp";
import { createProviderGate } from "@trust-graduation/core";

const gate = createProviderGate({
  store: sharedAtomicGrantStore,
  authenticateGrant: verifyApprovalIssuer,
  provider: existingProviderFunction,
  writeReceipt: durableReceiptSink
});

// Re-read the actual provider input at the final seam; never trust a preview.
const action = providerActionFromMcpBinding(
  heldReceipt.action_binding,
  actualProviderInput
);
const execution = await gate.execute({
  binding: heldReceipt.action_binding,
  approval: authenticatedMissionKey,
  action
});
```

The bridge verifies binding integrity and maps the intercepted identities,
target, constraints, expiry, and nonce into the core executor shape. The core
then re-hashes the actual provider input, authenticates and atomically consumes
the Key, calls the provider, and writes result-linked evidence. Mutation or
replay never reaches the provider.

For a generated adapter and objective provider-call counters:

```bash
npm install @trust-graduation/core@beta
npx trust-graduation init-adapter
npx trust-graduation conformance ./mission-gate-adapter.mjs --json
```

With both packages installed, the included compatibility proof is:

```bash
node node_modules/@trust-graduation/core/examples/mcp-provider-roundtrip.mjs
```

The MCP proxy still never resumes a held call merely because chat says
"approve". This bridge is for the separately authenticated approval host and
provider-bound executor.

## Install for Claude Desktop

```bash
npx -y @gomission/mcp@beta install-claude
```

The installer inspects the existing Claude Desktop MCP configuration:

- if it finds consequential MCP servers, it selects `--wrap`;
- otherwise it selects `--local`, an advisory exact-binding demonstration;
- it never auto-selects the hosted read-only mode.

Restart Claude Desktop after installation, then verify:

```bash
npx -y @gomission/mcp@beta verify
```

`verify` probes modern MCP with `server/discover` and `tools/list`, falling back
to the initialize-era protocol for older endpoints. Add `--json` for a
machine-readable report or `--no-probe` to inspect configuration only.

## Modes

| Mode | What it enforces | What it does not do |
| --- | --- | --- |
| `--wrap` | Intercepts selected child MCP servers; holds high/critical or low-confidence calls before the child; fails closed if a child is unavailable | Does not resume a held call or trust chat approval |
| `--local` | Records an advisory exact-action hold and local review receipt | Is not between another tool and its provider |
| `--remote` | Exposes hosted read-only Mission context | Does not intercept other MCP servers |

Choose explicitly when needed:

```bash
npx -y @gomission/mcp@beta install-claude --wrap
npx -y @gomission/mcp@beta install-claude --local
npx -y @gomission/mcp@beta install-claude --remote
```

Useful flags:

- `--workspace <path>` — store local receipts in an existing workspace.
- `--dry-run` — print the configuration change without writing it.
- `--force` — create configuration even when Claude Desktop is not detected.
- `--remote-url <url>` — override the hosted endpoint.
- `MISSION_DONT_WRAP="name1,name2"` — exclude selected MCP children.

## Exact hold contract

For a consequential wrapped call, the adapter writes a local receipt containing:

- action class;
- privacy-preserving local workspace identifier;
- requesting MCP child;
- target when one can be inferred;
- SHA-256 input commitment;
- one-execution constraints;
- expiry and nonce;
- SHA-256 commitment over the complete binding.

Receipts are written atomically with owner-only file permissions. The adapter
never stores the raw workspace path inside the binding. A local argument
summary remains in the receipt for human review, so treat the receipt directory
as sensitive workspace data.

## MCP compatibility

Preferred protocol: `2026-07-28`.

- stateless per-request `_meta` with client capabilities;
- mandatory `server/discover`;
- one JSON-RPC message per HTTP POST; modern batches and client notifications fail closed;
- HTTP binding for `MCP-Protocol-Version`, `Mcp-Method`, and `Mcp-Name`;
- protocol-defined `HeaderMismatch` and unsupported-version errors;
- `resultType: "complete"` and cache metadata;
- initialize-era compatibility for `2025-11-25` and `2024-11-05`.

The authority manifest is advertised through MCP discovery under the
experimental `mission-authority/v1` capability.

## Security boundary

The adapter does not claim:

- that a model or chat UI authenticated the principal;
- that a review receipt is an approval grant;
- exactly-once behavior at an external provider;
- independent conformance or production validation;
- global trust in an agent.

Use `@trust-graduation/core` to create and validate exact grants. The executor
must authenticate the grant issuer, re-bind the actual provider input, atomically
consume the key, invoke the provider at most once, and reconcile unknown
provider outcomes.

## Open-core boundary

Free and open:

- this MCP adapter;
- `@trust-graduation/core` and its schemas;
- `@gomission/mission-schemas` conformance vocabulary;
- the A2A exact-action authorization extension;
- Mission Lite’s local focus app.

Commercial Mission may provide managed policy, trusted approval surfaces,
hosted audit/receipt operations, organization controls, support, and provider
integrations. Product entitlements never grant action authority.

## Links

- Protocol: https://trustgraduation.org/
- A2A extension: https://trustgraduation.org/extensions/a2a/action-authorization/v1
- Mission: https://gomission.io/
- Source: https://github.com/gomission/mcp

## License

Apache-2.0. Mission names and logos are trademarks; the code license does not
grant permission to imply endorsement.
