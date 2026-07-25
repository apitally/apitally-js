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

// User providers can come from another OTel package copy, so detection uses API
// shape. A proxy with no delegate or only getTracer represents no provider setup.
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

// Apitally-Env and deployment.environment.name use the same resolution so they
// cannot disagree.
export function resolveEnv(hasUserProvider: boolean): string {
  // The env option and APITALLY_ENV are already resolved into config.env; its
  // default also indicates that neither was configured.
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
  // defaultResource() ignores environment variables, so envDetector supplies
  // them. Apitally attributes merge last to keep the env aligned with Apitally-Env.
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
  // Explicit sampler and length limits prevent OTel environment variables from
  // dropping upstream-unsampled SERVER spans or truncating long attributes.
  const provider = new NodeTracerProvider({
    sampler: new AlwaysOnSampler(),
    resource,
    spanProcessors,
    generalLimits: { attributeValueLengthLimit: MAX_ATTRIBUTE_VALUE_LENGTH },
    spanLimits: { attributeValueLengthLimit: MAX_ATTRIBUTE_VALUE_LENGTH },
  });
  // OTel global setters reject duplicate or version-mismatched registrations,
  // preserving existing registrations.
  trace.setGlobalTracerProvider(provider);
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

// Meter and logger providers remain private because global registration could
// replace or race a user's metrics or logs pipeline.
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

let distroVersion: string | undefined;

export function getDistroVersion(): string {
  distroVersion ??= (
    createRequire(import.meta.url)("../package.json") as { version: string }
  ).version;
  return distroVersion;
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

// OTel exposes no context-manager getter, so a propagated probe verifies
// registration. Without propagation, request contexts and suppression fail silently.
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
