# Agent guidance

Status: This branch (v1) is a new agent-generated codebase, largely untested and unreviewed. We're in the process of cleaning it up. The v1 SDK in this branch will supersede the v0 SDK in the main branch eventually.

## Checks

- Verify code changes with the npm scripts, never with hand-picked subsets of them: `npm run check` (Biome lint and format, tsc) and `npm test` (vitest). CI runs the same commands, so only their complete output counts as green.
- For documentation-only changes, review the diff and run `git diff --check`; reserve the npm scripts for code, configuration, or test changes.

## Code style

- Write the least amount of code that gets the job done.
- Write modern, idiomatic, strictly typed TypeScript within the supported range of Node.js >= 20.6.0: use what the floor version provides, nothing that requires a newer runtime.
- Imports are static and sit at the top of the module. Optional peer dependencies (winston, pino, @sentry/node, express) are resolved with a synchronous `createRequire` at activation, never with static imports or dynamic `import()` - activation is synchronous and module load stays side-effect-free.
- Every SDK-created promise chain carries rejection handling: timer callbacks, event listeners, and fire-and-forget sends must never produce an unhandled rejection, because an unhandled rejection crashes the host process.
- Privacy comes from not exporting. No underscore prefixes.
- Function order within a module is deliberate, not accidental: public entry points first, helpers after, so the module reads top-down.
- No single-use helper functions unless extraction meaningfully improves readability at the call site.
- Never use `instanceof` across OpenTelemetry package boundaries - the user's OTel objects may come from a different copy of the packages. Duck-type on properties instead.

## Naming and wording conventions

- Use plain, precise English. No invented shorthand, metaphors, or informal jargon.
- A word qualifies only by referring to an actual thing in this codebase or its dependencies, never by sounding technical: "SERVER span" (OTel `SpanKind.SERVER`), "spool" (the `Spool` class), "in-flight request map".
- Prefer a longer clear name over a compact clever one.
- Vague verbs need an object or a from/to: not `resolve` but `resolveEnv`.
- Boolean predicates read as questions: `is`/`should`/`has` prefixes. Never name a predicate as an imperative command.
- The name states what the function actually does, including its outcome: a function that only logs a warning is `warnIfSamplerDropsSpans`, not `checkSampler`.
- One concept, one name across modules.
- When renaming a function, rename its associated constants to match.
- Public API names (`useApitally`, `setConsumer`, `setRequestAttribute`, `captureException`, `shutdown`, `instrument`, `span`) are stable; naming improvements are internal only.

## Comments

- Comments are sparse and concise (one or two lines). A comment states something the code cannot: a constraint, an external system's behavior, or the reason for a choice. It explains the WHY, never narrates the WHAT; a comment that restates the code below it does not get written.
- Name the real component (the env var, the OTel class, the framework version behavior), never a metaphor.
- No historical references: nothing about the 0.x SDK, "previously", or "ported from". Comments describe the present code only.
- No references to planning or design documents. Every comment stands alone against the code and its dependencies; a comment that needs a rationale states the rationale itself.
- A comment sits next to the code it justifies and stays accurate about what that code covers.

## Testing

### What gets tested

- A test may only fail when user-observable behavior regresses against a contract. Documented gaps, internal mechanisms, and constants are never pinned; decisions without a user-observable failure mode are enforced in review, not tests.
- Every test needs an important reason to exist: it pins a spec requirement, a settled design decision, or a behavior a plausible change would silently break. Tests that restate the implementation, or assert theoretical edge cases no real deployment hits, do not get written.
- Test only the SDK's own code. Never write tests that assert what OpenTelemetry or a framework does on its own; dependencies appear in tests only as the environment the SDK's behavior is observed in.
- Never replace the SDK's own classes or functions with test doubles. Substitute only process boundaries: test HTTP policy at the fetch implementation production calls, and reserve a local server for focused physical transport coverage.
- Prefer one integration test proving a flow end-to-end over several micro-tests asserting its intermediate steps.
- Do not multiply a scenario into parameter variants; `it.each` is for genuine input tables.

### Layout and naming

- Two tiers: `tests/shared/<module>.test.ts` mirrors `src/` with one focused test module per source module; per-framework integration directories (`tests/express/`, `tests/hono/`) each drive a small uniform real app fixture. Test files are named after the module they test, never after scenarios.
- `describe` names the module or adapter; `it` is a present-tense behavior predicate readable without the test body, no "should". The name states the observable behavior, not the mechanism or an internal codename.
- Scenarios shared across frameworks use identical `it` strings in the same order in every framework file.
- Test order within a file is deliberate: core behavior first, then edge cases, failure paths, and shutdown last; hooks at the top.

### Coverage ownership

- Every behavior is asserted in exactly one home - the lowest layer that can observe it. `tests/shared/` owns core semantics; framework suites own adapter behavior, wiring, and the canonical cross-framework scenario set, which is the only sanctioned duplication. Two tests pinning the same contract outside that set is a defect.
- Helpers stay consolidated in `tests/utils.ts`: extending an existing helper always beats adding a sibling.

### Determinism and assertions

- No wall-clock sleeps and no fake timers. Use the deterministic seams: directly callable worker cycles, injectable pauses and timeouts, force-flush read helpers, file mtime manipulation.
- Assertions are exact by default: exact counts of spans, log records, and metric data points, full attribute equality, protobuf-decoded payloads in export tests. No snapshots.
- Integration tests read responses to completion before asserting on exports; telemetry for a request completes when its response body does.
- The global setup in `tests/setup.ts` isolates process-global state between tests (OTel API globals, the config singleton, env vars, patches) with teardown-based resets. Rely on it; tests never pre-clean.
