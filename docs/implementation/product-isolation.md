# Product isolation checkpoint

This is an implementation checkpoint, not release certification. The source product
is Base Context 0.1.0, with Prime Agent v0.9.3 ancestry retained.

## Owned surfaces

- Packages: `@ponythewhite/base-context`, `base-context-ai`, `base-context-agent`,
  and `base-context-tui` under the same scope and source graph.
- Commands: `base-context` and the separately installed `base-context-ai` helper.
- State: user/project `.base-context`, explicit validated `BASE_CONTEXT_*` overrides,
  separate Python distribution/environment, and product-owned diagnostic paths.
- Daemon: `base-context.daemon`, protocol 11, schema revision 39 (`protocol-11-schema-39-orphan-writer-owner`), home/install-scoped
  endpoints and rejection of foreign handshakes. Native work requires owned inference;
  older Base8 permits only explicitly passive inspection, not graceful cleanup.
- Auth: supported API-key/bearer routes remain. Copied, custom and MCP OAuth routes
  are unavailable until their distribution contract is validated. Registration alone
  does not validate a route. Provider IDs and ordinary provider endpoints stay intact.
- Export: local/off by default; explicit destinations and dedicated export credentials.
- Updates: owned npm package by default; private artifact origins require explicit
  configuration. Prepublish builds use the same source-only build and runtime payload.

## Identity differences that can reach model input

These are required product changes, not context optimizations:

- RLM and refinement prompts name Base Context rather than Prime Agent. Their useful
  tool/skill interfaces and control-phase policies are retained.
- Restart/update continuation notices name the fork; interrupted-work semantics stay
  unchanged.
- Tool/kernel error recovery refers to `base-context-runtime`, the owned managed
  environment, and `BASE_CONTEXT_KERNEL_PYTHON`. It never advises deleting an upstream
  runtime to repair the fork.
- State paths, temporary worker/REPL paths, executable commands and recovery/help
  diagnostics use owned product names. Such strings can appear in tool results.
- Auth attempts on unavailable routes return a distribution-specific explanation and
  supported API-key/bearer alternatives rather than initiating inherited OAuth.

Provider/model IDs, Python `import rlm`, MIME identifiers, existing custom-entry/RPC
IDs and ACP extension metadata keys are preserved where they are compatibility
interfaces. ACP agent product metadata identifies Base Context. The physical Python
source directory remains `prime-agent-runtime`; the distribution is
`base-context-runtime`. License and attribution notices remain in all packed products.

## Validation boundary

Local source builds and extracted package metadata/CLI probes passed. Same-home
running-product coexistence passed, including real Base cleanup/shutdown and upstream
survival. Native upgrade to the private 0.1.1 fixture, current-daemon launch, shutdown
and npm uninstall passed while upstream stayed responsive with unchanged settings/auth.
A separate clean-build installed SDK probe passed explicit legacy-path write rejection.
Those installed lifecycle probes used the earlier protocol8 checkpoint. Protocol9 has
focused compatibility tests, not a new installed-product certification.
Installed kernel, Windows execution, provider routes and final release tests remain
separate gates. No benchmark or publishing
claim follows from these source checks. The local 0.1.1 tarballs are upgrade fixtures.
