import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  type Context,
  context,
  createContextKey,
  propagation,
  SpanKind,
  TraceFlags,
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
import { LoggerProvider, type LogRecordProcessor } from "@opentelemetry/sdk-logs";
import { type IMetricReader, MeterProvider } from "@opentelemetry/sdk-metrics";
import {
  type Sampler,
  SamplingDecision,
  type SamplingResult,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { DEFAULT_ENV, getConfig } from "./config.js";
import { logDebug, logWarning } from "./logger.js";

const MAX_ATTRIBUTE_VALUE_LENGTH = 65_536;
const DEPLOYMENT_ENVIRONMENT_NAME = "deployment.environment.name";

class RequestRootedSampler implements Sampler {
  shouldSample(
    parentContext: Context,
    _traceId: string,
    _spanName: string,
    spanKind: SpanKind,
  ): SamplingResult {
    const parent = trace.getSpanContext(parentContext);
    const shouldRecord =
      spanKind === SpanKind.SERVER ||
      (parent !== undefined && !parent.isRemote && (parent.traceFlags & TraceFlags.SAMPLED) !== 0);
    return {
      decision: shouldRecord ? SamplingDecision.RECORD_AND_SAMPLED : SamplingDecision.NOT_RECORD,
    };
  }

  toString(): string {
    return "RequestRootedSampler";
  }
}

// Apitally-Env and deployment.environment.name use the same detected resource
// so they cannot disagree.
export function resolveEnvAndCreateResource(
  hasUserProvider: boolean,
  triggeringResource?: Pick<Resource, "attributes">,
): { env: string; resource: Resource } {
  const environmentResource = detectResources({ detectors: [envDetector] });
  const env = resolveEnv(hasUserProvider, triggeringResource, environmentResource);
  // defaultResource() ignores environment variables. Apitally attributes merge
  // last to keep the resource aligned with Apitally-Env.
  const resource = defaultResource()
    .merge(environmentResource)
    .merge(
      resourceFromAttributes({
        "service.instance.id": randomUUID(),
        [DEPLOYMENT_ENVIRONMENT_NAME]: env,
        "telemetry.distro.name": "apitally-js",
        "telemetry.distro.version": getDistroVersion(),
      }),
    );
  return { env, resource };
}

function resolveEnv(
  hasUserProvider: boolean,
  triggeringResource: Pick<Resource, "attributes"> | undefined,
  environmentResource: Pick<Resource, "attributes">,
): string {
  // The env option and APITALLY_ENV are already resolved into config.env; its
  // default also indicates that neither was configured.
  const configuredEnv = getConfig().env;
  const triggeringResourceEnv = readDeploymentEnvironmentNameFromResource(triggeringResource);
  if (triggeringResourceEnv !== undefined) {
    if (configuredEnv !== DEFAULT_ENV && configuredEnv !== triggeringResourceEnv) {
      logWarning(
        `The configured Apitally env "${configuredEnv}" conflicts with deployment.environment.name=${triggeringResourceEnv} on the OpenTelemetry SERVER span; using "${triggeringResourceEnv}". To resolve this, remove the env option from useApitally() or configure the provider resource with "${configuredEnv}".`,
      );
    }
    return triggeringResourceEnv;
  }
  const resourceAttributesEnv = readDeploymentEnvironmentNameFromResource(environmentResource);
  if (!hasUserProvider) {
    return configuredEnv !== DEFAULT_ENV ? configuredEnv : (resourceAttributesEnv ?? DEFAULT_ENV);
  }
  if (resourceAttributesEnv === undefined) {
    return configuredEnv;
  }
  if (configuredEnv !== DEFAULT_ENV && configuredEnv !== resourceAttributesEnv) {
    logWarning(
      `The configured Apitally env "${configuredEnv}" conflicts with the OTEL_RESOURCE_ATTRIBUTES entry deployment.environment.name=${resourceAttributesEnv} of the existing OpenTelemetry setup; using "${resourceAttributesEnv}". To resolve this, remove the env option from useApitally() or change the OTEL_RESOURCE_ATTRIBUTES entry to "${configuredEnv}".`,
    );
  }
  return resourceAttributesEnv;
}

export function setupTracerProvider(
  resource: Resource,
  spanProcessors: SpanProcessor[],
): NodeTracerProvider | undefined {
  // Explicit sampler and length limits prevent OTel environment variables from
  // dropping upstream-unsampled SERVER spans or truncating long attributes.
  const provider = new NodeTracerProvider({
    sampler: new RequestRootedSampler(),
    resource,
    spanProcessors,
    generalLimits: { attributeValueLengthLimit: MAX_ATTRIBUTE_VALUE_LENGTH },
    spanLimits: { attributeValueLengthLimit: MAX_ATTRIBUTE_VALUE_LENGTH },
  });
  // OTel global setters reject duplicate or version-mismatched registrations,
  // preserving existing registrations.
  if (!trace.setGlobalTracerProvider(provider)) {
    return undefined;
  }
  const contextManager = new AsyncLocalStorageContextManager();
  contextManager.enable();
  if (!context.setGlobalContextManager(contextManager)) {
    try {
      contextManager.disable();
    } catch (error) {
      logDebug(`Error disabling an unused OpenTelemetry context manager: ${String(error)}`);
    }
    warnIfContextDoesNotPropagate();
  }
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  return provider;
}

// Meter and logger providers remain private because global registration could
// replace or race a user's metrics or logs pipeline.
export function createMeterProvider(resource: Resource, readers: IMetricReader[]): MeterProvider {
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
  distroVersion ??= (createRequire(import.meta.url)("../package.json") as { version: string })
    .version;
  return distroVersion;
}

function readDeploymentEnvironmentNameFromResource(
  resource: Pick<Resource, "attributes"> | undefined,
): string | undefined {
  const value = resource?.attributes[DEPLOYMENT_ENVIRONMENT_NAME];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// OTel exposes no context-manager getter, so a propagated probe verifies
// registration. Without propagation, request contexts and suppression fail without an error.
function warnIfContextDoesNotPropagate(): void {
  let isPropagated = false;
  try {
    const probeKey = createContextKey("apitally-context-probe");
    isPropagated = context.with(
      context.active().setValue(probeKey, true),
      () => context.active().getValue(probeKey) === true,
    );
  } catch (error) {
    logDebug(`Error probing OpenTelemetry context propagation: ${String(error)}`);
  }
  if (!isPropagated) {
    logWarning(
      "OpenTelemetry context propagation is not working, so Apitally cannot associate telemetry with requests. This can happen when conflicting versions of @opentelemetry/api are installed.",
    );
  }
}
