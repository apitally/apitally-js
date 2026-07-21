# Apitally JS SDK v1 - Verification Spike Results

Resolved 2026-07-21, ahead of U1 (the spikes verify library behavior, not SDK code, so they needed no repo). Runtime: Node v26.3.1 (Bun 1.3.13 for the `@sentry/bun` leg). Every spike ran as throwaway scripts against the latest stable package versions; U1 pins exactly these versions and dependency versions stay frozen through U16 so these facts stay valid. Spike scripts live in the session scratchpad and are not committed. Spike 1 was removed earlier (D1 is instruct-only; number retained for reference stability).

Summary: all seven spikes resolved in favor of the design. Design-detail corrections: the spike-3 explicit-AnyValue fallback is dead (direct path only), metrics selectors must ride the SDK's own reader subclass or exporter (spike 5), the undici suppressTracing gap is closed upstream (spike 6), Sentry access is hybrid public-API-first (spike 7), and the log-capture floors are winston 3.2.0 / pino 9.6.0 (spike 8).

## Spike 2: Batch processor constructor config vs OTEL_BSP_*/OTEL_BLRP_* env vars

**Question:** does constructor config beat the env vars for every parameter on `BatchSpanProcessor` and `BatchLogRecordProcessor`?

**Versions:** @opentelemetry/sdk-trace-base 2.9.0 (wrapping @opentelemetry/sdk-trace 2.9.0), sdk-logs 0.220.0, api 1.9.1, api-logs 0.220.0, core 2.9.0.

**Verdict: yes, for every parameter on both processors, provided the passed value is not `undefined`.**

- BSP: `sdk-trace-base` ships a shim that applies env only when `config[param] === undefined`, per parameter, then delegates to the env-unaware `@opentelemetry/sdk-trace` class. Precedence is structural. Counter-check passed: an omitted parameter picks up its env value while explicit siblings stay put.
- BLRP: sdk-logs 0.220.0 never reads `OTEL_BLRP_*` on direct construction (omitted parameters fall back to hardcoded defaults 2048/1000/30000/512). The env vars are dead letters outside higher-level configurators.
- Env is read at construct time, not import time - import-order tricks give no protection; only explicit config does.
- Behavioral corroboration: with env demanding ~10s delays, explicit 300ms configs exported at ~300ms on both processors.

**Implementation constraints:**

1. Pass concrete numbers for all four parameters; explicit `undefined` counts as omitted and lets env in (a config spread from optional user fields is a hole).
2. The BSP shim mutates the config object passed to it (writes env fallbacks into it) - give each processor a fresh object literal.
3. BLRP takes a single options object `new BatchLogRecordProcessor({exporter, ...config})`; the old `(exporter, config)` positional form constructs silently broken processors (`_exporter === undefined`, crash on shutdown). Re-verify construction on every sdk-logs bump (0.x signature churn observed).
4. `maxExportBatchSize` is clamped to `maxQueueSize` with a diag warning.

## Spike 3: Bytes attributes through ProtobufTraceSerializer + spool gzip/concat semantics

**Question:** do `Buffer`/`Uint8Array` attribute values on hand-built export copies serialize to `bytesValue`, and do the spool's multi-member gzip + concatenated-protobuf semantics round-trip?

**Versions:** otlp-transformer 0.220.0, api 1.9.1, sdk-trace-base 2.9.0, resources 2.9.0, sdk-logs 0.220.0; independent decode via protobufjs 8.7.1 + opentelemetry-proto v1.5.0.

**Verdicts:**

1. **Bytes direct path - PASS.** Buffer and Uint8Array attribute values serialize to `AnyValue.bytes_value` byte-identically (independent protobufjs decode); string/int controls unaffected. The mechanism at 0.220.0 is the hand-rolled protobuf writer's `writeAnyValue` runtime type check (`instanceof Uint8Array`, checked before the Array/object branches, so bytes can never be misclassified as kvlist); `toAnyValue` survives only on the JSON path (base64). Docs reference the behavior, not a function name.
2. **Explicit-AnyValue fallback - DEAD.** A call-site `{bytesValue: ...}` value serializes as a kvlist (`{key: "bytesValue", ...}`), not bytes. The direct path is the only working path; a future version dropping the Uint8Array branch must be caught by the export tests, not routed around.
3. **Multi-member gzip - PASS.** `gunzipSync` and streaming `createGunzip` on concatenated gzip members return the exact concatenation of the raw payloads.
4. **Protobuf concatenation - PASS (traces and logs).** `payload1 + payload2` decodes as one valid Export*ServiceRequest whose repeated resource entries are exactly the concatenation of the parts, all spans/records and their bytes attributes intact.

**Implementation constraints:**

- Hand-built ReadableSpan-shaped copies MUST carry `events`/`links` as arrays (serializer iterates them unconditionally) and should carry the dropped*Count fields; `status`, hrtime tuples, valid hex trace/span ids, `resource.attributes`, `instrumentationScope.name` are read unconditionally.
- `resourceSpans` grouping is by **object identity**: spans of a batch must share the same `resource` and `instrumentationScope` references or each span gets its own resourceSpans entry (payload bloat). Export copies reuse the original references, never per-span clones.

## Spike 4: sdk-logs native eventName

**Question:** does the pinned sdk-logs line support the native `eventName` field for the startup event, or is the `event.name` attribute fallback needed?

**Versions:** api-logs 0.220.0, sdk-logs 0.220.0, otlp-transformer 0.220.0, resources 2.9.0; independent decode via protobufjs 8.7.1 + opentelemetry-proto v1.9.0.

**Verdict: native `eventName` fully supported; no fallback needed.**

- API: `logger.emit({eventName, body, attributes})` accepted; type declared on the api-logs `LogRecord`.
- SDK: exported `ReadableLogRecord.eventName` carries the value.
- Wire: lands in the native `LogRecord.event_name` proto field (field 12), byte-level verified; not duplicated into attributes.
- Body: a structured JS-object body (`{framework, versions: {...}, paths: [{...}]}`) survives to the wire as a nested `kvlistValue` AnyValue - the startup event can rely on it.
- Fallback verified in passing (not needed): an `event.name` string attribute would survive as a normal attribute.

**Implementation notes:** sdk-logs 0.220.0 takes processors in the `LoggerProvider` constructor (`{processors: [...]}`; no `addLogRecordProcessor`), and `SimpleLogRecordProcessor` takes `{exporter}` - the positional form drops records silently.

## Spike 5: Exponential histogram downscale + selectors

**Question:** is downscale-by-merge to scale <= 3 exact, and do delta/exponential selectors scope to histograms with gauges unaffected?

**Versions:** sdk-metrics 2.9.0, api 1.9.1, resources 2.9.0.

**Verdict: all pass (20/20 checks).**

- **Merge is exact.** `newIndex = Math.floor(oldIndex / 2**(srcScale - 3))` (Math.floor, not `>>`, for negative indices) produced buckets identical to a native scale-3 aggregator and to per-value direct index computation (`ceil(log2(v) * 8) - 1`, 0 mismatches over 819 values) on wide (5-2000ms), narrow (80-120ms), and bucket-boundary datasets; count/sum/min/max/zeroCount pass through untouched; scale <= 3 input is a no-op pass-through. The merge operates purely on indices - no float-log arithmetic enters the export path.
- **The downscale is genuinely needed:** 500 latencies clustered 80-120ms yield scale 8 at default maxSize 160 (ingest accepts [-2, 6], target is 3 per reference parity).
- **Selector isolation:** exponential aggregation + DELTA temporality selected for HISTOGRAM instruments only; gauges stay last-value and report the last recorded value across collects; delta semantics verified across successive collects.
- Boundary convention: lower-exclusive/upper-inclusive; exact powers of 2 land in the lower bucket. Irrelevant to the merge (index-only) but relevant to test assertions.
- Histogram instruments drop negative values at the API level, so negative buckets are only trivially exercised - fine for duration/size metrics.

**Selector wiring constraint:** `PeriodicExportingMetricReader` ignores reader-level selector options and derives selectors exclusively from the exporter's `selectAggregation`/`selectAggregationTemporality` methods; plain `MetricReader` subclasses do accept `aggregationSelector`/`aggregationTemporalitySelector` options. The SDK's non-periodic worker-driven reader subclass carries the selectors (or the exporter implements the two methods); return `{type: AggregationType.EXPONENTIAL_HISTOGRAM}` for HISTOGRAM, `{type: AggregationType.DEFAULT}` otherwise.

## Spike 6: instrumentation-undici ignoreRequestHook + proxy dispatcher

**Question:** does `ignoreRequestHook` reliably filter the SDK's export requests, and does it behave with the `EnvHttpProxyAgent` in play?

**Versions:** instrumentation-undici 0.30.0, instrumentation 0.220.0, api 1.9.1, core 2.9.0, sdk-trace-node/base 2.9.0, undici 6.27.0.

**Verdicts:**

1. **ignoreRequestHook - PASS.** Origin + path matching suppressed spans for both `request()` and `fetch()` to the fake ingest endpoint, spans intact elsewhere, hook called exactly once per request. Hook receives undici's core Request object: `origin` (string, no trailing slash; typed `string | URL`, so coerce), `path` (string including query), `method`, headers, etc.
2. **suppressTracing gap is CLOSED.** instrumentation-undici 0.30.0 passes the active context into `startSpan`, and sdk-trace 2.9.0 returns a non-recording span for suppressed contexts - zero spans under `suppressTracing` for both `request()` and `fetch()`. The previously planned upstream issue is moot. The hook stays primary (explicit contract of this instrumentation; covers older copies in user setups); suppression works as a second layer at current versions.
3. **Proxy dispatcher - PASS.** With `HTTP_PROXY` set and `EnvHttpProxyAgent` as per-request or global dispatcher: requests demonstrably traverse the proxy, spans carry the TARGET url (never the proxy's), the hook receives the TARGET origin/path, filtering still works. The proxy layer is invisible to instrumentation (dispatcher-level vs diagnostics_channel request-level) - no special handling needed.
4. **disable() - PASS.** No spans after `instrumentation.disable()`.

**Implementation notes:** `EnvHttpProxyAgent` is experimental in undici 6.27.0 and emits a process warning on construction - construct lazily and only when proxy env vars are set (the design already does). undici proxying is CONNECT-only, even for plain-http targets; a proxy without CONNECT support hangs clients indefinitely - relevant to test harnesses (the stub proxy must speak CONNECT).

## Spike 7: Sentry client access per package and major

**Question:** carrier walk vs `createRequire("@sentry/node")` + `getClient()` - which path, and what supported set?

**Versions tested:** @sentry/node 7.120.4 / 8.55.2 / 9.47.1 / 10.66.0 (all maintained majors); @sentry/nextjs 10.66.0 (npm + pnpm strict layouts); @sentry/bun 10.66.0 (Bun 1.3.13); @sentry/aws-serverless 10.66.0. Nothing blocked - even @sentry/nextjs initialized standalone in plain Node.

**Verdict: hybrid, public API first.** Try `getClient()` off a synchronous `createRequire("@sentry/node")` resolution; fall back to the `globalThis.__SENTRY__` carrier walk.

- The createRequire path is stable API and covered every npm-layout combination including nextjs/bun/aws-serverless (all depend on @sentry/node transitively; hoisting makes it resolvable), returning the same client instance the wrapper initialized (the client lives on the global carrier, so dual-copy/CJS-into-ESM concerns are moot - verified).
- Its one hard failure: strict layouts (pnpm, Yarn PnP) where transitive deps are not resolvable from the app. Next.js + pnpm is common, so createRequire-only is not acceptable coverage.
- The carrier walk passed all 8 legs including pnpm and Bun, with exactly two shapes across four majors: v7 `__SENTRY__.hub.getClient()`; v8/9/10 `__SENTRY__[__SENTRY__.version].acs.getCurrentScope().getClient()` (byte-for-byte what public `getClient()` does; `defaultCurrentScope.getClient()` is a secondary fallback). Internal API, so it is the fallback, not primary.
- `beforeSendEvent` fires with `event.event_id` on every tested package and major, v7 included. No Sentry package ships ESM-only (all ship CJS; the `node` exports condition precedes `import`).
- Trap for tests, irrelevant to the access paths: ESM `import` of @sentry/nextjs yields a namespace where `getClient` is only on `ns.default` (cjs-module-lexer misses star re-exports).

**Supported set:** `@sentry/node` >= 7 plus `@sentry/nextjs`, `@sentry/bun`, `@sentry/aws-serverless`. Matrix pins Sentry majors 7 and 10.

## Spike 8: winston/pino capture floors

**Question:** how far back do the PoC-verified attach mechanisms (winston ensure-attached transport via prototype-shadow; pino discovery patch + `hooks.streamWrite` retrofit) hold?

**Runtime:** Node v26.3.1; winston 3.0.0-3.19.0 sweep, pino 8.21.0-10.3.1 sweep.

**Verdict: winston floor 3.2.0, pino floor 9.6.0.**

- **winston:** all assertions pass on 3.2.0 through 3.19.0 with zero mechanism drift (prototype discovery via `configure`, shadow write, re-attach after `clear()`, backlog drain all identical). 3.0.0/3.1.0 fail only because `Logger.child` does not exist yet (landed 3.2.0). Every version resolved winston-transport@^4 to 4.9.0 - which mirrors the real shape: the SDK resolves the transport base alongside the winston peer (design-js §9), and even the oldest winston's own ^4 range lands on modern 4.9.x, so old-winston-core + modern-transport-base interop is exactly what was proven. (winston's `Logger.add` duck-types transports - isStream, log arity, objectMode - so base-class copy identity never matters.) Engines all below Node 20.
- **pino:** the brief's assumption that `hooks.streamWrite` landed mid-8.x was wrong - it landed in **pino 9.6.0**; no 8.x release has it. 9.6.0, 9.14.0, and 10.3.1 pass everything (incl. redact/serializers post-policy, custom messageKey, formatters.level immunity, worker-thread transports, multistream once-only, default-hooks sharing via pino's shallow option merge). 8.21.0/9.0.0/9.5.0 fail as silent no-capture: symbols, prototype discovery, hook installation, and delegation all work, the hook just never fires (the write path predates the `streamWrite` consult); even a creation-time `hooks.streamWrite` is silently ignored. So below-floor pino degrades gracefully - no crash, no capture - and the docs must say so. pino publishes no engines field; docs-level support is Node >= 18 (pino 9) / >= 20 (pino 10).

**Peer ranges: `winston >=3.2.0 <4`, `pino >=9.6.0 <11`. Matrix pins: winston 3.2.0 + 3.19.x, pino 9.6.0 + 10.x.**

Harness pitfall (relevant to U8/U15 tests): pino unrefs its worker-transport ThreadStream, so a standalone script can exit silently mid-assertions - hold a ref'd timer open until done.
