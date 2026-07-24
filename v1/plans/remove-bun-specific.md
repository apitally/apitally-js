---
title: Remove Bun-Specific Implementation
type: refactor
date: 2026-07-24
status: implementation-ready
---

# Remove Bun-Specific Implementation

## Goal

Keep Hono applications on Bun within the supported runtime scope while removing every Bun-specific production branch and workaround. Transport decisions should depend only on configuration, never runtime identity, and the implementation should become smaller.

Automatic proxy support on Bun is not a requirement. It must not justify runtime detection, a transport adapter, custom proxy matching, or any other additional abstraction.

## Verified Current State

The supplied audit is substantially correct. The production implementation has two Bun-specific areas:

| File | Current behavior | Decision |
| --- | --- | --- |
| `src/exportWorker.ts` | Detects `globalThis.Bun`, selects Bun's non-standard per-request `proxy` option, and implements a Bun-only `NO_PROXY` matcher. | Remove the detection, Bun proxy option, proxy URL selection, and custom matcher. |
| `src/capture.ts` | Reads `teedResponse.headers` only to force Bun's lazy `Response` implementation to initialize them. | Remove the access and its comment. |

The audit's recommendation to retain `void teedResponse.headers` as generic normalization is not consistent with the stated goal. The access has no portable observable purpose, and the source comment identifies it as a Bun workaround. Renaming the comment would hide the special case rather than remove it.

The working tree already removes the dedicated `bun:test` suite, `test:bun` package script, CI job, and TypeScript/Vitest exclusions. No other production module detects Bun or uses a Bun API. References in `README.md`, package keywords, design history, and Sentry package names are support declarations or documentation, not runtime special handling.

## Design Decisions

### 1. Use one export transport decision

`ExportWorker` keeps its existing runtime-neutral decision:

- With no proxy environment variable, send with global `fetch`.
- With a proxy environment variable, use the existing lazy `undici.fetch` and `EnvHttpProxyAgent` path.

There is no runtime detection or fallback. `EnvHttpProxyAgent` remains responsible for `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` semantics on the supported Node path. If that same path happens to work on Bun, that is incidental. Proxy behavior on Bun is not part of the support contract and receives no special handling.

This preserves tested Node proxy behavior while deleting the only runtime split and the duplicate `NO_PROXY` implementation.

### 2. Keep response capture standards-based

Construct the replacement `Response` with the original status, status text, and headers, then return it without forcing any property access. Existing shared capture and Hono streaming tests define the portable behavior that matters: headers remain readable and the body reaches the caller while it is captured.

Do not replace the removed access with feature detection, an eager header clone added only for Bun, or another workaround.

### 3. Remove Bun-specific test machinery

Keep the deletion of `tests/bun/hono.test.ts`, the Bun CI job, package script, and configuration exclusions. A separate runtime lane, test runner, and duplicate end-to-end scenario are unnecessary.

Existing shared capture and Hono suites continue to define the portable behavior. They run through the normal Node test command only. Hono-on-Bun remains a compatibility claim based on runtime-neutral code, without dedicated runtime validation.

### 4. Keep support declarations and align current design docs

Keep:

- The Hono-on-Bun support statement in `README.md`.
- The `bun` package keyword.
- Generic Hono implementation code.
- Historical review and spike records.
- References to external packages such as `@sentry/bun` where they describe supported integrations.

Update the current implementation descriptions in `v1/design-js.md` and `v1/plan.md` so they no longer claim a native Bun proxy branch, a Bun response-header workaround, or dedicated Bun CI coverage. Keep the Hono-on-Bun support scope accurate.

## Implementation Steps

### 1. Delete the Bun export path

Update `src/exportWorker.ts`:

- Delete `runtimeIsBun` and `bunProxyUrl`.
- Delete the `"Bun" in globalThis` check.
- Delete constructor logic that chooses a Bun proxy URL and calls `shouldBypassProxy()`.
- Delete the `fetch(..., { proxy })` branch from `postFile()`.
- Delete `shouldBypassProxy()` in full.
- Keep `useProxy`, `ProxyTransport`, `getProxyTransport()`, lazy Undici loading, and dispatcher shutdown unchanged.

Afterward, `postFile()` has only the direct global-fetch path and the existing Undici proxy path. Add no replacement helper or option.

### 2. Delete the response-header workaround

Update `src/capture.ts`:

- Delete the Bun-specific two-line comment.
- Delete `void teedResponse.headers`.
- Leave the surrounding `Response` construction and stream capture unchanged.

No new test is needed. `tests/shared/capture.test.ts` already asserts preserved headers and non-buffering stream capture, and `tests/hono/hono.test.ts` already covers streamed Hono responses.

### 3. Finish the test and CI simplification

Keep the current working-tree changes that remove:

- `tests/bun/hono.test.ts`
- `test:bun` from `package.json`
- `tests/bun` exclusions from `tsconfig.json` and `vitest.config.ts`
- The Bun-runner wording from `tests/harness.ts`
- The `test-bun` job and its `ci-gate` dependency from `.github/workflows/tests.yaml`

Do not add a replacement runtime lane or Bun-only test source.

Leave the Node proxy scenario in `tests/shared/exportWorker.test.ts` unchanged. It owns the supported proxy contract and verifies that `HTTP_PROXY` routes an export through `EnvHttpProxyAgent`.

### 4. Remove stale implementation claims

Update `v1/design-js.md`:

- Remove the native Bun proxy branch and its known-gap wording from the runtime and HTTP client sections.
- Describe global `fetch` as the default transport and lazy Undici as the proxy transport when proxy variables are configured.
- State that proxy support is validated on Node and is outside the Hono-on-Bun support claim.
- Remove the claimed Bun workaround from the response capture section.
- Remove wording that says Bun never loads the Undici proxy path.

Update `v1/plan.md`:

- Remove the native Bun proxy option from U5.
- Remove the Bun workaround from the capture work in U10.
- Remove Bun-specific CI from U16 and the verification contract.
- Replace the obsolete risk about the untested Bun proxy branch with the explicit decisions that Bun proxy behavior is outside the support contract and Bun has no dedicated test lane.

Do not rewrite historical review or spike documents. Their descriptions remain records of earlier decisions.

## Tradeoffs

### Bun proxy behavior is no longer implemented separately

A Bun process without proxy variables uses the same global-fetch path as every other runtime. A Bun process with proxy variables takes the common Undici path, which may or may not work under Bun's Node compatibility layer. The SDK does not detect, correct, or document around that outcome.

This is intentional. Preserving automatic Bun proxy support would retain the non-standard option and custom `NO_PROXY` code or replace them with a larger abstraction.

### The lazy-header workaround is removed

The unconditional property access may have hidden a Bun runtime defect. Removing the dedicated Bun lane means runtime regressions will not be detected by this repository's CI. Do not restore runtime detection or a Bun-only workaround; any future fix must be a genuinely portable simplification.

### Bun is not separately validated

The support claim remains scoped to Hono and rests on its runtime-neutral Web API implementation. Express, logging-library patches, outgoing client spans, proxy support, and Bun runtime drift are outside dedicated CI coverage.

## Verification

First confirm that production source contains no remaining Bun-specific implementation:

```sh
rg -n '\bBun\b|runtimeIsBun|bunProxyUrl|shouldBypassProxy' src
```

The search should return no matches.

Run the repository's complete required checks:

```sh
npm run check
npm test
```

Confirm the existing Node proxy scenario remains green as part of `npm test`. Do not add a Bun runtime or proxy scenario.

## Completion Criteria

- `src/` contains no Bun detection, Bun API, Bun-only branch, or Bun-specific workaround comment.
- `runtimeIsBun`, `bunProxyUrl`, the non-standard `proxy` fetch option, and `shouldBypassProxy()` are gone.
- `void teedResponse.headers` and its Bun comment are gone.
- Direct exports still use global `fetch` when no proxy variables are configured.
- Node proxy exports still use lazy `undici.fetch` with `EnvHttpProxyAgent`, including its built-in `NO_PROXY` behavior.
- No transport adapter, injected proxy seam, feature detection, or replacement proxy matcher is added.
- The dedicated Bun test source, package script, CI job, and test configuration exclusions remain deleted.
- No Bun runtime command or dedicated Bun scenario runs in CI.
- Hono-on-Bun support declarations remain in `README.md` and package metadata.
- Current design documents no longer describe removed Bun implementation paths.
- Production source has a net code reduction.
- `npm run check` and `npm test` pass.
