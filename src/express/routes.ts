import { logDebug, logWarning } from "../logger.js";
import type { RoutePath } from "../startup.js";

// Route templates only exist at registration time: the router keeps them inside
// path-to-regexp closures, so the registration methods on the shared router
// prototype are patched to buffer every path argument per router instance.
// Assembly happens per request from mount segments tracked during dispatch.

const ROUTER_PATCH_MARKER = Symbol.for("apitally.expressRouterPatch");
const ROUTE_PATCH_MARKER = Symbol.for("apitally.expressRoutePatch");
// Request-scoped tracking state lives on the request object itself, so the
// dispatch patches and the transport middleware share it across module copies.
const ROUTE_STATE_KEY = Symbol.for("apitally.expressRouteState");

const INLINE_PARAM_REGEX_PATTERN = /(:\w+)\([^)]*\)/g;
const PURE_WILDCARD_SEGMENT_PATTERN = /^\/?\{\*[^}]*\}$/;

const REGISTER_IMPORT_HINT =
  'add `import "apitally/express/register";` as the first line of your application\'s entry module';

interface CapturedRoute {
  path: unknown;
  methods?: Record<string, boolean>;
}

interface CapturedMount {
  pathTemplates: string[];
  handler: unknown;
}

interface RouterCaptureTable {
  routes: CapturedRoute[];
  mounts: CapturedMount[];
}

interface RouteTrackingState {
  mountSegments: string[];
  mountBaseUrls: string[];
  assembledTemplate?: string;
  sawCapturedRouteDispatch: boolean;
}

export interface RouteTrackingResult {
  route?: string;
  matchedUncapturedRegistration: boolean;
}

const captureTables = new WeakMap<object, RouterCaptureTable>();
// Routes registered through the patched prototype. The dispatch patch only
// assembles for these, so registrations made before the patch behave the same
// on every express major, independent of how the router binds dispatch.
const capturedRoutes = new WeakSet<object>();

// Installs the capture patches through a probe router created with the given
// express module; used by the register entry with the peer-resolved copy.
export function installRouteCaptureFromExpress(expressModule: unknown): void {
  const routerFactory = (expressModule as { Router?: unknown } | undefined)
    ?.Router;
  if (typeof routerFactory !== "function") {
    logDebug("The express module does not expose a Router factory");
    return;
  }
  installRouteCapturePatches((routerFactory as () => object)());
}

// Installs the capture patches through the app's own router, covering express
// copies the peer resolution cannot see (bundled or duplicated installs).
export function installRouteCaptureFromApp(app: unknown): void {
  const router = resolveAppRouter(app);
  if (!router) {
    logDebug("The express app's router was not found");
    return;
  }
  installRouteCapturePatches(router);
}

export function beginRouteTracking(req: object): void {
  const state: RouteTrackingState = {
    mountSegments: [],
    mountBaseUrls: [],
    sawCapturedRouteDispatch: false,
  };
  (req as Record<symbol, unknown>)[ROUTE_STATE_KEY] = state;
}

// Resolves the request's final route template: the assembled template must
// prefix-match the actual request path, otherwise the route is cleared. A
// request that matched a route without a captured registration is reported so
// the transport can warn about it.
export function finishRouteTracking(
  req: object,
  requestPath: string,
): RouteTrackingResult {
  const state = (req as Record<symbol, unknown>)[ROUTE_STATE_KEY] as
    | RouteTrackingState
    | undefined;
  const matchedExpressRoute = (req as { route?: unknown }).route !== undefined;
  if (!state) {
    return { matchedUncapturedRegistration: false };
  }
  if (state.assembledTemplate !== undefined) {
    if (matchesTemplate(state.assembledTemplate, requestPath, "prefix")) {
      return {
        route: state.assembledTemplate,
        matchedUncapturedRegistration: false,
      };
    }
    // A mount segment is missing from the assembly, so a registration in the
    // chain was made before the capture patch was installed.
    return { matchedUncapturedRegistration: true };
  }
  if (state.sawCapturedRouteDispatch) {
    // The dispatched route has no meaningful template (e.g. a pure catch-all)
    return { matchedUncapturedRegistration: false };
  }
  return { matchedUncapturedRegistration: matchedExpressRoute };
}

// Enumerates the captured registration table into the startup event's paths,
// walking mounted routers depth-first with their mount prefixes.
export function resolveStartupPaths(app: unknown): RoutePath[] {
  const router = resolveAppRouter(app);
  if (!router) {
    return [];
  }
  const paths: RoutePath[] = [];
  collectStartupPaths(router, "", new Set(), paths);
  return paths;
}

function collectStartupPaths(
  router: object,
  prefix: string,
  visited: Set<object>,
  paths: RoutePath[],
): void {
  if (visited.has(router)) {
    return;
  }
  const table = captureTables.get(router);
  if (!table) {
    return;
  }
  for (const route of table.routes) {
    const methods = Object.keys(route.methods ?? {})
      .filter((method) => method !== "_all")
      .map((method) => method.toUpperCase());
    for (const template of routePathTemplates(route.path)) {
      const fullPath = joinTemplateParts(prefix, template);
      for (const method of methods) {
        paths.push({ method, path: fullPath });
      }
    }
  }
  for (const mount of table.mounts) {
    if (typeof mount.handler !== "function") {
      continue;
    }
    for (const pathTemplate of mount.pathTemplates) {
      collectStartupPaths(
        mount.handler as object,
        joinTemplateParts(prefix, pathTemplate),
        new Set([...visited, router]),
        paths,
      );
    }
  }
}

function installRouteCapturePatches(routerInstance: object): void {
  const routerPrototype = findOwnerOfProperty(routerInstance, "route");
  if (!routerPrototype || typeof routerPrototype.route !== "function") {
    logDebug("The express router prototype was not recognized");
    return;
  }
  if (routerPrototype[ROUTER_PATCH_MARKER] !== true) {
    patchRouterPrototype(routerPrototype);
  }
  const probeRoute = createProbeRoute(routerPrototype);
  if (!probeRoute) {
    logDebug("The express route prototype was not recognized");
    return;
  }
  const routePrototype = findOwnerOfProperty(probeRoute, "dispatch");
  if (!routePrototype || typeof routePrototype.dispatch !== "function") {
    logDebug("The express route prototype was not recognized");
    return;
  }
  if (routePrototype[ROUTE_PATCH_MARKER] !== true) {
    patchRoutePrototype(routePrototype);
  }
}

function patchRouterPrototype(
  routerPrototype: Record<PropertyKey, unknown>,
): void {
  const originalRoute = routerPrototype.route as (
    ...args: unknown[]
  ) => CapturedRoute;
  routerPrototype.route = function (
    this: object,
    ...args: unknown[]
  ): CapturedRoute {
    const route = originalRoute.apply(this, args);
    try {
      tableFor(this).routes.push(route);
      capturedRoutes.add(route as unknown as object);
    } catch (error) {
      logDebug(`Error capturing an express route: ${String(error)}`);
    }
    return route;
  };

  const originalUse = routerPrototype.use as (...args: unknown[]) => unknown;
  routerPrototype.use = function (this: object, ...args: unknown[]): unknown {
    try {
      const table = tableFor(this);
      const pathTemplates = extractPathTemplates(args[0]);
      const handlers = flattenHandlers(args.slice(1));
      if (pathTemplates && handlers.length > 0) {
        return originalUse.call(
          this,
          args[0],
          ...handlers.map((handler) =>
            wrapMountHandler(handler, pathTemplates, table),
          ),
        );
      }
    } catch (error) {
      logDebug(`Error capturing an express mount: ${String(error)}`);
    }
    return originalUse.apply(this, args);
  };
  routerPrototype[ROUTER_PATCH_MARKER] = true;
}

function patchRoutePrototype(
  routePrototype: Record<PropertyKey, unknown>,
): void {
  const originalDispatch = routePrototype.dispatch as (
    ...args: unknown[]
  ) => unknown;
  routePrototype.dispatch = function (
    this: { path?: unknown },
    ...args: unknown[]
  ): unknown {
    try {
      const req = args[0] as Record<symbol, unknown> & { url?: unknown };
      const state = req[ROUTE_STATE_KEY] as RouteTrackingState | undefined;
      if (state && capturedRoutes.has(this)) {
        state.sawCapturedRouteDispatch = true;
        state.assembledTemplate = assembleTemplate(
          state.mountSegments,
          resolveDispatchedRoutePath(this.path, req.url),
        );
      }
    } catch (error) {
      logDebug(`Error assembling an express route template: ${String(error)}`);
    }
    return originalDispatch.apply(this, args);
  };
  routePrototype[ROUTE_PATCH_MARKER] = true;
}

// The wrapper tracks descent into mounted routers and sub-apps: it pushes the
// mount's template segment for the duration of the handler and pops when the
// handler passes the request back out through next().
function wrapMountHandler(
  handler: unknown,
  pathTemplates: string[],
  table: RouterCaptureTable,
): unknown {
  if (typeof handler !== "function") {
    return handler;
  }
  table.mounts.push({ pathTemplates, handler });
  warnIfRouterHasUncapturedRegistrations(handler);
  if (handler.length >= 4) {
    // Error middleware never descends into route dispatch
    return handler;
  }
  const mountHandler = handler as (
    req: object,
    res: object,
    next: (error?: unknown) => void,
  ) => unknown;
  return function (
    this: unknown,
    req: Record<symbol, unknown> & { baseUrl?: unknown },
    res: object,
    next: (error?: unknown) => void,
  ): unknown {
    const state = req[ROUTE_STATE_KEY] as RouteTrackingState | undefined;
    if (!state) {
      return mountHandler.call(this, req, res, next);
    }
    const baseUrl = typeof req.baseUrl === "string" ? req.baseUrl : "";
    const parentBaseUrl =
      state.mountBaseUrls[state.mountBaseUrls.length - 1] ?? "";
    const consumedPath = baseUrl.startsWith(parentBaseUrl)
      ? baseUrl.slice(parentBaseUrl.length)
      : baseUrl;
    state.mountSegments.push(pickMatchingTemplate(pathTemplates, consumedPath));
    state.mountBaseUrls.push(baseUrl);
    let exited = false;
    return mountHandler.call(this, req, res, (error?: unknown) => {
      if (!exited) {
        exited = true;
        state.mountSegments.pop();
        state.mountBaseUrls.pop();
      }
      next(error);
    });
  };
}

function warnIfRouterHasUncapturedRegistrations(handler: unknown): void {
  const stack = (handler as { stack?: unknown }).stack;
  if (
    Array.isArray(stack) &&
    stack.length > 0 &&
    !captureTables.has(handler as object)
  ) {
    logWarning(
      `The routes of a mounted router were registered before Apitally could capture them, so requests to that router are exported without route templates. To resolve this, ${REGISTER_IMPORT_HINT}.`,
    );
  }
}

export function warnAboutUncapturedRouteRegistrations(): void {
  logWarning(
    `Some requests matched routes that Apitally did not capture at registration time. These requests are exported without a route template and are not counted in the request metrics. To resolve this, ${REGISTER_IMPORT_HINT}.`,
  );
}

function tableFor(router: object): RouterCaptureTable {
  let table = captureTables.get(router);
  if (!table) {
    table = { routes: [], mounts: [] };
    captureTables.set(router, table);
  }
  return table;
}

// A stub carrier lets the original route() mint a Route instance for the
// prototype walk without registering a layer anywhere.
function createProbeRoute(
  routerPrototype: Record<PropertyKey, unknown>,
): object | undefined {
  try {
    const stub = Object.create(routerPrototype) as Record<string, unknown>;
    stub.caseSensitive = false;
    stub.strict = false;
    stub.stack = [];
    const route = (routerPrototype.route as (path: string) => unknown).call(
      stub,
      "/",
    );
    return typeof route === "object" && route !== null ? route : undefined;
  } catch {
    return undefined;
  }
}

function resolveAppRouter(app: unknown): object | undefined {
  const appObject = app as {
    lazyrouter?: unknown;
    _router?: unknown;
    router?: unknown;
  };
  try {
    if (typeof appObject.lazyrouter === "function") {
      appObject.lazyrouter();
    }
  } catch {
    // The router is resolved from the properties below
  }
  if (typeof appObject._router === "function") {
    return appObject._router as object;
  }
  try {
    // Reading app.router throws on express 4, where _router is used instead
    return typeof appObject.router === "function"
      ? (appObject.router as object)
      : undefined;
  } catch {
    return undefined;
  }
}

function findOwnerOfProperty(
  instance: object,
  key: PropertyKey,
): Record<PropertyKey, unknown> | undefined {
  let target: object | null = instance;
  while (target !== null && !Object.hasOwn(target, key)) {
    target = Object.getPrototypeOf(target) as object | null;
  }
  return (target as Record<PropertyKey, unknown> | null) ?? undefined;
}

function extractPathTemplates(pathArgument: unknown): string[] | undefined {
  if (typeof pathArgument === "string") {
    return [normalizeInlineRegexParams(pathArgument)];
  }
  if (
    Array.isArray(pathArgument) &&
    pathArgument.length > 0 &&
    pathArgument.every((path) => typeof path === "string")
  ) {
    return pathArgument.map(normalizeInlineRegexParams);
  }
  return undefined;
}

function flattenHandlers(args: unknown[]): unknown[] {
  return args.flat(Number.POSITIVE_INFINITY);
}

function pickMatchingTemplate(
  pathTemplates: string[],
  consumedPath: string,
): string {
  if (pathTemplates.length === 1) {
    return pathTemplates[0];
  }
  return (
    pathTemplates.find((template) =>
      matchesTemplate(template, consumedPath, "full"),
    ) ?? pathTemplates[0]
  );
}

// The dispatched route's registered path: arrays resolve to the member
// matching the request's remaining path, regular expressions have no template.
function resolveDispatchedRoutePath(
  routePath: unknown,
  requestUrl: unknown,
): string | undefined {
  if (typeof routePath === "string") {
    return normalizeInlineRegexParams(routePath);
  }
  if (Array.isArray(routePath)) {
    const templates = routePath
      .filter((path): path is string => typeof path === "string")
      .map(normalizeInlineRegexParams);
    const remainingPath =
      typeof requestUrl === "string" ? requestUrl.split("?")[0] : "";
    return (
      templates.find((template) =>
        matchesTemplate(template, remainingPath, "full"),
      ) ?? templates[0]
    );
  }
  return undefined;
}

// Joins mount segments and the route path into the full template, dropping
// segments that carry no information: bare slashes and pure wildcards.
function assembleTemplate(
  mountSegments: string[],
  routePath: string | undefined,
): string | undefined {
  if (routePath === undefined) {
    return undefined;
  }
  const parts = [...mountSegments, routePath].filter(isMeaningfulSegment);
  const template = parts.join("").replace(/\/{2,}/g, "/");
  return template === "" ? "/" : template;
}

function isMeaningfulSegment(segment: string): boolean {
  return (
    segment !== "/" &&
    segment !== "*" &&
    segment !== "/*" &&
    !PURE_WILDCARD_SEGMENT_PATTERN.test(segment)
  );
}

// Strips express 4 inline parameter patterns, e.g. /items/:id(\d+) becomes
// /items/:id; express 5 rejects the syntax at registration.
function normalizeInlineRegexParams(path: string): string {
  return path.replace(INLINE_PARAM_REGEX_PATTERN, "$1");
}

function routePathTemplates(routePath: unknown): string[] {
  if (typeof routePath === "string") {
    return [normalizeInlineRegexParams(routePath)];
  }
  if (Array.isArray(routePath)) {
    return routePath
      .filter((path): path is string => typeof path === "string")
      .map(normalizeInlineRegexParams);
  }
  return [];
}

function joinTemplateParts(prefix: string, part: string): string {
  const joined = (prefix + (part === "/" ? "" : part)).replace(/\/{2,}/g, "/");
  return joined === "" ? "/" : joined;
}

// Templates come from a fixed set of registrations but are matched per
// request, so compiled patterns are cached; the bounded key space needs no eviction.
const compiledTemplatePatterns = new Map<string, RegExp | undefined>();

// Structural template matching in express syntax: named parameters match one
// path segment, wildcards match any remainder, braced groups are optional.
// Matching stays permissive on unrecognized syntax so a legitimate route is
// never cleared by the validation.
function matchesTemplate(
  template: string,
  path: string,
  mode: "full" | "prefix",
): boolean {
  if (template === "/") {
    return path === "/" || path === "";
  }
  const key = `${mode} ${template}`;
  if (!compiledTemplatePatterns.has(key)) {
    compiledTemplatePatterns.set(key, compileTemplatePattern(template, mode));
  }
  const pattern = compiledTemplatePatterns.get(key);
  return pattern ? pattern.test(path) : true;
}

function compileTemplatePattern(
  template: string,
  mode: "full" | "prefix",
): RegExp | undefined {
  const suffix = mode === "full" ? "/?$" : "(?:/|$)";
  try {
    return new RegExp(`^${templateToRegExpSource(template)}${suffix}`, "i");
  } catch {
    return undefined;
  }
}

function templateToRegExpSource(template: string): string {
  let source = "";
  let index = 0;
  while (index < template.length) {
    const char = template[index];
    if (char === ":" || char === "*") {
      index += 1;
      while (index < template.length && /\w/.test(template[index])) {
        index += 1;
      }
      source += char === ":" ? "[^/]+" : ".*";
      continue;
    }
    if (char === "{") {
      const end = template.indexOf("}", index);
      if (end !== -1) {
        source += `(?:${templateToRegExpSource(template.slice(index + 1, end))})?`;
        index = end + 1;
        continue;
      }
    }
    source += char.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    index += 1;
  }
  return source;
}
