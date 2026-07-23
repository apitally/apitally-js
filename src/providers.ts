import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  context,
  createContextKey,
  propagation,
  type TracerProvider,
  trace,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  defaultResource,
  detectResources,
  envDetector,
  type Resource,
  resourceFromAttributes,
} from "@opentelemetry/resources";
import {
  LoggerProvider,
  type LogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import { type IMetricReader, MeterProvider } from "@opentelemetry/sdk-metrics";
import {
  AlwaysOnSampler,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { DEFAULT_ENV, getConfig } from "./config.js";
import { logWarning } from "./logger.js";

const MAX_ATTRIBUTE_VALUE_LENGTH = 65_536;
const DEPLOYMENT_ENVIRONMENT_NAME = "deployment.environment.name";

// Duck-typed because the user's provider may come from a different copy of the
// OTel packages: the API global is a ProxyTracerProvider, and a delegate that is
// absent or exposes only the API surface (getTracer) is the no-setup noop.
export function hasUserTracerProvider(): boolean {
  const globalProvider = trace.getTracerProvider() as TracerProvider & {
    getDelegate?: () => TracerProvider;
  };
  const delegate = (
    typeof globalProvider.getDelegate === "function"
      ? globalProvider.getDelegate()
      : globalProvider
  ) as TracerProvider & { forceFlush?: unknown; shutdown?: unknown };
  return (
    typeof delegate.forceFlush === "function" ||
    typeof delegate.shutdown === "function"
  );
}

// The Apitally-Env export header and the resource's deployment.environment.name
// both come from this one resolution, so the two can never disagree.
export function resolveEnv(hasUserProvider: boolean): string {
  // The env option and APITALLY_ENV are already folded into config.env, whose
  // default doubles as the not-explicitly-configured sentinel.
  const configuredEnv = getConfig().env;
  const resourceAttributesEnv = readDeploymentEnvironmentNameFromEnv();
  if (!hasUserProvider) {
    return configuredEnv !== DEFAULT_ENV
      ? configuredEnv
      : (resourceAttributesEnv ?? DEFAULT_ENV);
  }
  if (resourceAttributesEnv === undefined) {
    return configuredEnv;
  }
  if (
    configuredEnv !== DEFAULT_ENV &&
    configuredEnv !== resourceAttributesEnv
  ) {
    logWarning(
      `The configured Apitally env "${configuredEnv}" conflicts with the OTEL_RESOURCE_ATTRIBUTES entry deployment.environment.name=${resourceAttributesEnv} of the existing OpenTelemetry setup; using "${resourceAttributesEnv}". To resolve this, remove the env option from useApitally() or change the OTEL_RESOURCE_ATTRIBUTES entry to "${configuredEnv}".`,
    );
  }
  return resourceAttributesEnv;
}

export function createResource(env: string): Resource {
  // defaultResource() alone reads no env vars; the envDetector merge honors
  // OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES. The Apitally-owned keys are
  // merged last and win, so the resource env always matches the Apitally-Env header.
  return defaultResource()
    .merge(detectResources({ detectors: [envDetector] }))
    .merge(
      resourceFromAttributes({
        "service.instance.id": randomUUID(),
        [DEPLOYMENT_ENVIRONMENT_NAME]: env,
        "telemetry.distro.name": "apitally-js",
        "telemetry.distro.version": getDistroVersion(),
      }),
    );
}

export function setupTracerProvider(
  resource: Resource,
  spanProcessors: SpanProcessor[],
): NodeTracerProvider {
  // The sampler and both length limit settings are passed explicitly so the
  // OTEL_TRACES_SAMPLER and OTEL_(SPAN_)ATTRIBUTE_VALUE_LENGTH_LIMIT env vars
  // never apply: a SERVER span under an unsampled upstream traceparent must still
  // record, and a low limit would clip long attributes like the full request URL.
  const provider = new NodeTracerProvider({
    sampler: new AlwaysOnSampler(),
    resource,
    spanProcessors,
    generalLimits: { attributeValueLengthLimit: MAX_ATTRIBUTE_VALUE_LENGTH },
    spanLimits: { attributeValueLengthLimit: MAX_ATTRIBUTE_VALUE_LENGTH },
  });
  trace.setGlobalTracerProvider(provider);
  // The API refuses duplicate or version-mismatched registrations, leaving any
  // pre-existing user registration untouched.
  const contextManager = new AsyncLocalStorageContextManager();
  contextManager.enable();
  context.setGlobalContextManager(contextManager);
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  warnIfContextPropagationIsInert();
  return provider;
}

export function warnAboutExistingTracerProvider(): void {
  logWarning(
    "An existing OpenTelemetry tracer provider was detected, and Apitally will not replace it. Only metrics and the startup event are sent to Apitally until you add ApitallySpanProcessor (exported by the apitally package) to your tracer provider's spanProcessors constructor option or the NodeSDK spanProcessors option.",
  );
}

// The meter and logger providers are private instances backed by the Apitally
// resource, never registered into the OTel API globals: global registration would
// overwrite or race a user's own metrics or logs pipeline.
export function createMeterProvider(
  resource: Resource,
  readers: IMetricReader[],
): MeterProvider {
  return new MeterProvider({ resource, readers });
}

export function createLoggerProvider(
  resource: Resource,
  processors: LogRecordProcessor[],
): LoggerProvider {
  return new LoggerProvider({ resource, processors });
}

export function getDistroVersion(): string {
  const packageJson = createRequire(import.meta.url)("../package.json") as {
    version: string;
  };
  return packageJson.version;
}

function readDeploymentEnvironmentNameFromEnv(): string | undefined {
  const raw = process.env.OTEL_RESOURCE_ATTRIBUTES;
  if (!raw) {
    return undefined;
  }
  for (const entry of raw.split(",")) {
    const separatorIndex = entry.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }
    if (entry.slice(0, separatorIndex).trim() !== DEPLOYMENT_ENVIRONMENT_NAME) {
      continue;
    }
    const value = entry.slice(separatorIndex + 1).trim();
    try {
      return decodeURIComponent(value) || undefined;
    } catch {
      return value || undefined;
    }
  }
  return undefined;
}

// The API exposes no getter for the registered context manager, so the outcome of
// the registration attempt is verified by observing whether context values propagate.
// Without a working context manager, per-request contexts and trace suppression
// silently stop working.
function warnIfContextPropagationIsInert(): void {
  const probeKey = createContextKey("apitally-context-probe");
  const isPropagated = context.with(
    context.active().setValue(probeKey, true),
    () => context.active().getValue(probeKey) === true,
  );
  if (!isPropagated) {
    logWarning(
      "OpenTelemetry context propagation is not working, so Apitally cannot associate telemetry with requests. This can happen when conflicting versions of @opentelemetry/api are installed.",
    );
  }
}
