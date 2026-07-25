---
title: Remove Stub OTLP Server
type: refactor
date: 2026-07-25
status: implementation-ready
---

# Remove Stub OTLP Server

## Goal

Delete the specialized OTLP server fixture and simplify network-facing tests around the boundary each test owns.

Use fetch spies with real `Response` objects for SDK request policy, retries, orchestration, and lifecycle wiring. Keep one direct HTTP export smoke using the existing `withServer` helper. Add no mocking dependency and make no production transport changes.

The objective is less custom testing code, not maximum integration coverage for behavior owned by Node or Undici. The implementation must produce a clear net reduction in test infrastructure and total test code.

## Verified Current State

| File | Current state | Direction |
| --- | --- | --- |
| `tests/stubOtlpServer.ts` | A 153-line fixture captures requests, scripts responses, hangs or resets sockets, tracks sockets, waits for request counts, and implements CONNECT forwarding. | Delete without replacement. |
| `tests/shared/exportWorker.test.ts` | Starts the fixture for every test and uses real sockets for request policy, status handling, retries, timeout, and proxy behavior. | Move SDK-owned behavior to fetch spies and retain one direct HTTP smoke. |
| `tests/shared/activation.test.ts` | Uses the fixture for two outgoing CLIENT-span tests and three lifecycle delivery tests. | Use `withServer` for outgoing requests and global fetch spies for lifecycle delivery. |
| `tests/express/express.test.ts` | Uses the fixture to observe the close-triggered export cycle. | Observe the cycle through a deferred global fetch spy. |
| `tests/utils.ts` | Provides `withServer` and already imports Vitest for shared test helpers. | Reuse `withServer` and consolidate the repeated successful-fetch spy and path extraction here. |
| `tests/setup.ts` | Stops SDK state before calling `vi.restoreAllMocks()` in global teardown. | Continue relying on it for spy restoration. |
| `src/exportWorker.ts` | Uses global `fetch` directly, or lazily resolves package Undici and calls `undici.fetch` with an `EnvHttpProxyAgent` when proxy variables exist. | Leave unchanged and test both existing call boundaries. |

The current documentation names or prescribes the specialized fixture in `AGENTS.md`, `v1/design.md`, `v1/design-js.md`, and `v1/plan.md`.

The Python v1 suite has a simpler 40-line `StubOTLPServer` in `../apitally-py/tests/conftest.py` for focused transport tests. Its `exporters` fixture prevents network access in many activation and framework tests. It does not cover physical reset, HTTP timeout, or CONNECT behavior. This supports using the smallest useful boundary per language, but does not require the JS suite to keep a server class.

The following alternatives were verified and rejected:

- Undici `MockAgent` does not reliably span Node's bundled fetch and package Undici across the supported Node range, and the production proxy path supplies an explicit dispatcher that bypasses a global mock agent.
- Current Nock excludes Node 20.6 through 20.11 and does not intercept the explicit package Undici fetch path.
- MSW does not intercept the explicit package Undici fetch path.
- Mockttp 4.5 can cover direct HTTP, reset, timeout, and CONNECT without production changes, but a fresh install measured 39 MB and 194 packages. That dependency is disproportionate to the retained SDK coverage.

## Design Decisions

### 1. Test direct request policy at global fetch

For non-proxy worker tests, spy on the existing production boundary:

```ts
vi.spyOn(globalThis, "fetch")
```

Return a fresh real `Response` for every call. Never reuse a consumed `Response` and never substitute a response-shaped object.

Inspect fetch calls to cover SDK-owned behavior:

- Exact URL and request signal.
- POST method.
- Authorization, environment, content type, content encoding, and user agent headers.
- Gzip request body contents.
- Response status classification.
- Export interval response-header parsing and clamping.
- Retry call counts and byte-identical request bodies.
- Pending-file deletion or retention.
- Cycle send cap and final-drain behavior.
- Timer start and cycle coalescing.
- Timeout classification and lack of an immediate timeout retry.

Do not add an injectable transport or another test seam to production code.

### 2. Keep one direct HTTP export smoke

Use the existing `withServer` helper in `tests/utils.ts` for one focused export-worker test.

An inline event-based listener collects each request body, records its path and headers, and returns an empty 200 response. Keep assertions outside the listener. Append one payload for each signal, run one cycle, and assert:

- Paths are `/v1/traces`, `/v1/logs`, and `/v1/metrics`.
- Export headers reach the server.
- Each gzip body decompresses to the original payload.
- Successful files leave the queue.

Introduce no reusable server class, request waiter, socket tracker, or proxy helper.

### 3. Spy on the exact package Undici object for proxy coverage

Resolve Undici at module scope in `tests/shared/exportWorker.test.ts` with `createRequire`:

```ts
const undici = createRequire(import.meta.url)("undici") as typeof import("undici");
```

This is the mutable cached CommonJS exports object that production resolves later. Spy on `undici.fetch`, not an ESM namespace and not global fetch.

Set `HTTP_PROXY` before constructing the worker because the constructor records whether proxy variables exist. Return a fresh successful `Response` and assert:

- Package `undici.fetch` is called once.
- The URL is the expected OTLP trace URL.
- The request body contains the expected stored gzip bytes.
- The request dispatcher is an instance of `undici.EnvHttpProxyAgent`.

Let the worker's normal `stop()` path close the real dispatcher before teardown completes. Do not start a proxy or assert CONNECT behavior.

### 4. Model fetch failures at the fetch contract

A non-timeout transport failure is a rejected fetch promise. Queue at least two files and reject both attempts for the first file. Assert exactly two calls with byte-identical bodies, no attempt for the second file, and retention of both files. This one scenario covers the immediate retry, retry limit, cycle termination, and queue outcome.

For timeout classification, the mock must use the request's actual signal:

1. Inspect `init.signal`.
2. Reject immediately with `signal.reason` if it is already aborted.
3. Otherwise register a once-only abort listener.
4. Reject with `signal.reason` from that listener.

This gives the worker the native `TimeoutError` reason produced by `AbortSignal.timeout()` and proves that timeout does not trigger the immediate non-timeout retry.

### 5. Use deterministic promise gates

Timer, concurrency, and close-triggered flush tests may defer a mocked fetch response. Every deferred response must have a deterministic observation and release path.

- Resolve an observation promise when fetch is entered.
- Hold the fetch with a response promise owned by the test.
- Release the response before any assertion that could throw.
- Await every worker cycle that can observe the deferred response.

Use no sleeps, fake timers, polling assertions, or unresolved promises.

### 6. Keep lifecycle tests at their owning boundary

Outgoing CLIENT-span production requires a real outgoing request, so those activation tests use `withServer`.

Module-copy sharing, shutdown, `beforeExit`, and Express server-close tests own lifecycle wiring rather than HTTP transport. They use global fetch spies and exact OTLP path assertions.

Install each lifecycle spy before activation or before the request that triggers activation. This ensures the worker cannot reach native fetch before the test boundary exists.

### 7. Accept narrower transport integration coverage

Retain:

- One real direct HTTP export smoke.
- All SDK-owned request formation, response policy, retry policy, queue behavior, timer behavior, concurrency behavior, timeout classification, and lifecycle wiring.
- Proxy branch selection and the dispatcher contract.

Physical connection refusal, TCP reset, real hung-socket abort, and `EnvHttpProxyAgent` CONNECT forwarding are covered by Node and Undici rather than this repository.

### 8. Add no mocking dependency

Use Vitest's existing spy API and the project's existing Undici dependency. Leave `package.json` and `package-lock.json` unchanged.

## Implementation Steps

### 1. Rewrite `tests/shared/exportWorker.test.ts`

Update imports and setup:

- Add `createRequire` from `node:module`.
- Add the Node HTTP header types needed by the inline direct-server capture.
- Remove `createServer as createNetServer` from `node:net`.
- Remove the `StubOtlpServer` import.
- Import and reuse `withServer`.
- Delete `findUnusedPort()`.
- Delete the server field and server setup and cleanup.
- Give `createWorker()` a fixed test endpoint, with an endpoint override for the direct HTTP smoke.
- Keep worker shutdown, spool clearing, and temporary-directory removal.
- Let global setup restore spies after worker teardown. Do not add local `vi.restoreAllMocks()` calls.

Extend `tests/utils.ts` with `spyOnSuccessfulFetch()` and `readFetchPaths()`. These shared helpers guarantee a fresh successful `Response` per call and remove repeated path extraction across worker and lifecycle tests. Do not recreate a request recorder abstraction.

Keep one direct HTTP smoke:

- Use `withServer` with an inline body-capturing listener.
- Append traces, logs, and metrics.
- Assert three paths, export headers, decompressed bodies, and an empty queue.
- Install no global fetch spy in this test.

Convert the remaining worker scenarios:

- Request construction: return success and assert URL, method, full headers, gzip body, and queue deletion at global fetch.
- Timer start: resolve an observation promise when fetch starts, then return a successful response and await the cycle deterministically.
- Failed send across cycles: return 503 then 200 and compare both fetch bodies byte-for-byte.
- Outage probe: return repeated 503 responses, then successful responses, asserting one probe per cycle and byte-identical eventual delivery.
- Ten-file cycle cap: return success and assert exactly `MAX_SENDS_PER_CYCLE` calls and two queued files.
- Export interval: return fresh responses carrying `Apitally-Export-Interval`, including clamped and invalid values.
- Mid-cycle coalescing: hold the first fetch, call `runCycle()` again, release the response, and assert each file is posted once.
- Suppressed tracing: leave the scenario network-free.
- Proxy selection: spy on the cached CommonJS Undici object and assert the dispatcher contract.
- Permanent 4xx: select status from the requested URL and retain once-per-status warning assertions.
- Retryable statuses: return real 408, 429, 500, and 503 responses and retain queued-file assertions.
- Connection retry limit: queue two files, reject both attempts for the first file, and assert two byte-identical calls, no attempt for the second file, and retention of both files.
- Timeout: reject from the request signal's abort reason and assert one call plus one queued file.
- Expired-file final drain: return success for the fresh file and assert only the logs URL was fetched.
- Uncapped final drain: return success for every request and compare decompressed call bodies to all expected payloads.

Keep deliberate test ordering: primary request behavior, direct smoke, timer and concurrency, proxy selection, status and failure policy, then final drain.

### 2. Update `tests/shared/activation.test.ts`

Remove the `StubOtlpServer` import, server field, and local server cleanup hook.

Replace the two outgoing request tests with `withServer`:

- Return an empty successful response from the inline listener.
- Make the outgoing global fetch inside the `withServer` callback.
- Read the response body to completion.
- Retain the existing CLIENT-span assertions for SDK-owned and user-owned tracer-provider paths.

Replace network delivery in the lifecycle tests:

- Install a successful global fetch spy before activation. Return a fresh `Response` per call.
- Module-copy test: invoke shutdown through the second module copy and assert exactly `/v1/logs` and `/v1/metrics`.
- Repeated shutdown test: assert `/v1/traces`, `/v1/logs`, and `/v1/metrics`, then prove later shutdown calls add no fetch calls.
- `beforeExit` test: emit `beforeExit`, await the shared shutdown promise, and assert exactly `/v1/metrics`.

Keep serializer-spy assertions because they prove lifecycle draining populated the spool before fetch. Fetch path assertions prove delivery wiring.

### 3. Update `tests/express/express.test.ts`

Remove the `StubOtlpServer` import and add `vi` to the Vitest import.

Rewrite the server-close test with a deferred global fetch spy:

1. Install the spy before the request triggers activation.
2. Make the first fetch return a deferred response and resolve an observation promise when it starts.
3. Complete the application request.
4. Close the long-lived Express server.
5. Await the first fetch observation to prove the close listener started an export cycle.
6. Call `requireActivationHandles().worker.runCycle()` while the first fetch remains pending so the call joins the close-triggered cycle.
7. Release the first fetch with a successful `Response`.
8. Await the joined cycle.
9. Assert the exact sorted paths `/v1/metrics` and `/v1/traces`.

Return fresh immediate responses for later calls. Release the deferred fetch before assertions that could throw, and leave no pending worker cycle for global teardown.

### 4. Delete `tests/stubOtlpServer.ts`

Delete the file after all three importers have been migrated.

Confirm no test imports or names `StubOtlpServer`, `StubResponse`, `CapturedRequest`, or `stubOtlpServer`. Add no replacement server or proxy fixture.

### 5. Preserve teardown ownership

Keep `tests/setup.ts` unchanged. Its teardown order remains important:

1. `resetProcessGlobals()` stops active workers and clears process-global state.
2. `vi.restoreAllMocks()` restores global fetch and package Undici fetch.

Locally created workers still stop in their suite teardown. A running worker must never reach native fetch after a spy has been restored.

## Test and Coverage Ownership

| Behavior | Owning test | Boundary |
| --- | --- | --- |
| Direct URL, method, headers, and body construction | `tests/shared/exportWorker.test.ts` | Global fetch spy |
| Status handling, interval header, retry counts, byte identity, and queue outcomes | `tests/shared/exportWorker.test.ts` | Global fetch spy with real responses |
| Timer scheduling and cycle coalescing | `tests/shared/exportWorker.test.ts` | Deferred global fetch |
| Timeout classification | `tests/shared/exportWorker.test.ts` | Abort-aware global fetch rejection |
| Proxy branch and dispatcher selection | `tests/shared/exportWorker.test.ts` | Cached package Undici fetch spy |
| Ordinary direct HTTP delivery | `tests/shared/exportWorker.test.ts` | Existing `withServer` helper |
| Outgoing CLIENT-span production | `tests/shared/activation.test.ts` | Existing `withServer` helper |
| Module-copy, shutdown, and `beforeExit` delivery wiring | `tests/shared/activation.test.ts` | Global fetch spy |
| Express close-triggered flush wiring | `tests/express/express.test.ts` | Deferred global fetch spy |
| Physical connection failures, TCP reset, hung-socket abort, and CONNECT | Node and Undici | Outside repository coverage |

## Documentation Updates

Make surgical corrections only where removing the fixture makes a current statement false. Prefer deletion or direct replacement, keep the documentation diff neutral or reducing where practical, and do not repeat the full testing strategy across documents.

### `AGENTS.md`

Replace the testing sentence that prescribes the stub server with one concise rule: process-boundary spies own HTTP policy, while a local server is reserved for focused physical transport coverage. Preserve the existing unrelated uncommitted status-line addition.

### `v1/design.md`

Replace only the cross-language statement that makes a local stub server the general solution for headers, retries, and spool interaction. State that policy and orchestration use the language's network-call seam and that a local server may provide focused transport coverage. Leave the surrounding fork guidance unchanged.

### `v1/design-js.md`

Replace the scriptable stub-server statement with a short current-state description: fetch spies own request policy and lifecycle tests, and one `withServer` smoke owns direct HTTP transport. Keep the existing mutable-object seam explanation for the CommonJS Undici spy.

### `v1/plan.md`

Remove `tests/stubOtlpServer.ts` from the target structure and make direct replacements at the existing fixture references in the key decisions and U5, U9, U12, and U13. Name the owning fetch-spy or `withServer` boundary without adding new rationale sections. Remove obsolete socket reset, hung-socket, CONNECT, and full-assembly claims. Preserve historical spike and review records.

## Verification

Run the repository's complete required scripts:

```sh
npm run check
npm test
```

Do not use a focused Vitest invocation as final verification. No package installation or lockfile update is expected.

Also verify the simplification directly:

```sh
rg -n "StubOtlpServer|StubResponse|CapturedRequest|stubOtlpServer" . --glob '!v1/plans/remove-stub-otlp-server.md'
git diff --stat
git diff --numstat -- tests
```

The symbol search must return no current source, test, or current-design references. Historical commit messages are outside this check. The test diff must show a clear net deletion.

## Acceptance Criteria

- `tests/stubOtlpServer.ts` is deleted.
- No current source, test, or design document imports or names the deleted fixture.
- No new server fixture, proxy fixture, request waiter, socket tracker, or mocking dependency is added.
- `src/exportWorker.ts` remains unchanged.
- SDK-owned export policy is tested through global fetch spies with fresh real `Response` objects.
- Repeated successful-fetch setup and path extraction are consolidated in `tests/utils.ts` without adding a request recorder.
- The proxy test spies on the cached CommonJS package `undici.fetch` and asserts an `EnvHttpProxyAgent` dispatcher.
- Exactly one direct HTTP export smoke uses the existing `withServer` helper.
- Activation's outgoing CLIENT-span tests use `withServer`.
- Activation lifecycle and Express close-triggered delivery use fetch spies with exact path assertions.
- Timeout rejection comes from `init.signal.reason`.
- Timer and concurrency tests use deterministic observation and release gates.
- No sleeps, fake timers, polling, or unreleased promises are introduced.
- Physical connection failures, TCP reset, real hung-socket abort, and CONNECT forwarding are explicitly outside retained coverage.
- Current design and plan documents no longer prescribe or name the deleted fixture, and their updates are short replacements or deletions rather than duplicated testing rationale.
- The unrelated existing `AGENTS.md` status-line change is preserved.
- `package.json` and `package-lock.json` remain unchanged.
- Test infrastructure and total test code have a clear net reduction.
- `npm run check` and `npm test` pass.
