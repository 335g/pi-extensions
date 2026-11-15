# Deterministic commit scope via path mapping instead of LLM inference

When a `scope` mapping is present in `.pi/pi-autocommit.json`, the
Conventional Commits scope is resolved by a deterministic path-matching
module (`scope-resolver.ts`) rather than inferred by the LLM. The LLM is
instructed to write `type: subject` (no scope) and the scope is injected
afterwards; any LLM-emitted scope is stripped and overwritten. When no
`scope` key is set, the previous LLM-driven behaviour is preserved.

## Considered options

- **A. Prompt injection (soft).** Tell the LLM about the mapping and trust
  it to comply. Rejected because the user motivation is to *fix* the
  scope, and an LLM is not a reliable enforcer — cross-scope commits and
  drift would remain.
- **B. Post-hoc overwrite.** Let the LLM emit freely, then rewrite
  `type(scope):` after the fact. Rejected as brittle: subject-line parsing
  is fragile and the reorganiser's `=== COMMIT ===` blocks would all need
  rewriting.
- **C. Deterministic resolver, LLM stripped of scope (chosen).** The scope
  becomes the responsibility of a single deep module that both the LLM
  path and the heuristic fallback call. This keeps "the LLM is the single
  quality source for *semantic* content" philosophy intact while moving the
  *mechanical label* (scope) to a path-driven resolver.

## Consequences

- A new `scope-resolver.ts` module owns glob matching (picomatch),
  longest-literal-wins precedence, the mapping → heuristic → null
  cascade, and the "mixed scopes → omit scope" rule.
- `determineScope` in `commit-message.ts` is replaced by a call to
  `resolveScope`; the old heuristic becomes the fallback tier.
- When `scope` is set, both `llm-commit.ts` and `commit-organizer.ts`
  switch to a "no scope" prompt and reassemble `type(scope): subject`
  themselves, normalising any LLM-emitted scope away.
- Checkpoint commits (`wip(checkpoint):`) are untouched — they are
  temporary and reset before reorganisation, so mapping does not apply to
  them and the `WIP_COMMIT_MARKER` stays stable.
- Backward compatible: users without a `scope` key see no change.