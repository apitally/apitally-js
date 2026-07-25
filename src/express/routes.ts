import { logDebug, logWarning } from "../logger.js";
import type { RoutePath } from "../startup.js";

const ROUTER_PATCH_MARKER = Symbol.for("apitally.expressRouterPatch");
const ROUTE_PATCH_MARKER = Symbol.for("apitally.expressRoutePatch");
const APP_USE_PATCH_MARKER = Symbol.for("apitally.expressAppUsePatch");
// Request-scoped tracking state lives on the request object itself, so the
// dispatch patches and the transport middleware share it across module copies.
const ROUTE_STATE_KEY = Symbol.for("apitally.expressRouteState");

const INLINE_PARAM_REGEX_PATTERN = /(:\w+)\([^)]*\)/g;
const PURE_WILDCARD_SEGMENT_PATTERN = /^\/?\{\*[^}]*\}$/;

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

interface RouteTrackingResult {
  route?: string;
  matchedUncapturedRegistration: boolean;
}

const captureTables = new WeakMap<object, RouterCaptureTable>();
// Dispatch assembles only routes captured after patching, independent of how
// each Express version binds dispatch.
const capturedRoutes = new WeakSet<object>();

// Express stores templates in path-to-regexp closures, so a probe from the user's
// Express module locates and patches the shared router prototypes.
export function installRouteCaptureFromExpress(expressModule: unknown): void {
  const routerFactory = (expressModule as { Router?: unknown } | undefined)?.Router;
  if (typeof routerFactory !== "function") {
    logDebug("The express module does not expose a Router factory");
    return;
  }
  installRouteCapturePatches((routerFactory as () => object)());
  // Apps copy prototype methods at creation, so the patch reaches apps created
  // after this import.
  patchApplicationUse((expressModule as { application?: unknown }).application);
}

// The app's own router covers bundled or duplicated Express copies that peer
// resolution cannot reach.
export function installRouteCaptureFromApp(app: unknown): void {
  const router = resolveAppRouter(app);
  if (!router) {
    logDebug("The express app's router was not found");
    return;
  }
  installRouteCapturePatches(router);
  patchApplicationUse(app);
}

export function beginRouteTracking(req: object): void {
  const state: RouteTrackingState = {
    mountSegments: [],
    mountBaseUrls: [],
    sawCapturedRouteDispatch: false,
  };
  (req as Record<symbol, unknown>)[ROUTE_STATE_KEY] = state;
}

// A template that does not prefix-match the request path indicates an uncaptured
// registration.
export function finishRouteTracking(req: object, requestPath: string): RouteTrackingResult {
  const state = (req as Record<symbol, unknown>)[ROUTE_STATE_KEY] as RouteTrackingState | undefined;
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
    // The dispatched route has no meaningful template, such as a pure catch-all.
    return { matchedUncapturedRegistration: false };
  }
  return { matchedUncapturedRegistration: matchedExpressRoute };
}

export function resolveStartupPaths(app: unknown): RoutePath[] {
  const router = resolveAppRouter(app);
  if (!router) {
    return [];
  }
  const paths: RoutePath[] = [];
  collectStartupPaths(router, "", new Set(), new Set(), paths);
  return paths;
}

function collectStartupPaths(
  routerOrSubApp: object,
  prefix: string,
  visited: Set<object>,
  seenPaths: Set<string>,
  paths: RoutePath[],
): void {
  const router = captureTables.has(routerOrSubApp)
    ? routerOrSubApp
    : resolveSubAppRouter(routerOrSubApp);
  if (!router || visited.has(router)) {
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
        const key = `${method} ${fullPath}`;
        if (!seenPaths.has(key)) {
          seenPaths.add(key);
          paths.push({ method, path: fullPath });
        }
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
        seenPaths,
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

function patchRouterPrototype(routerPrototype: Record<PropertyKey, unknown>): void {
  const originalRoute = routerPrototype.route as (...args: unknown[]) => CapturedRoute;
  routerPrototype.route = function (this: object, ...args: unknown[]): CapturedRoute {
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
      if (pathTemplates) {
        const handlers = flattenHandlers(args.slice(1));
        if (handlers.length > 0) {
          return originalUse.call(
            this,
            args[0],
            ...handlers.map((handler) => wrapMountHandler(handler, pathTemplates, table)),
          );
        }
      } else if (isHandlerFirstArgument(args[0])) {
        // use() without a path mounts at "/"
        return originalUse.apply(
          this,
          flattenHandlers(args).map((handler) => wrapMountHandler(handler, ["/"], table)),
        );
      }
    } catch (error) {
      logDebug(`Error capturing an express mount: ${String(error)}`);
    }
    return originalUse.apply(this, args);
  };
  routerPrototype[ROUTER_PATCH_MARKER] = true;
}

function patchRoutePrototype(routePrototype: Record<PropertyKey, unknown>): void {
  const originalDispatch = routePrototype.dispatch as (...args: unknown[]) => unknown;
  routePrototype.dispatch = function (this: { path?: unknown }, ...args: unknown[]): unknown {
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

// Express replaces mounted sub-apps with closures before routing, so app.use is
// patched while each sub-app remains visible. Dispatch tracking stays router-level.
function patchApplicationUse(target: unknown): void {
  const targetObject = target as Record<PropertyKey, unknown> | undefined;
  const originalUse = targetObject?.use;
  if (
    typeof originalUse !== "function" ||
    (originalUse as unknown as Record<PropertyKey, unknown>)[APP_USE_PATCH_MARKER] === true
  ) {
    return;
  }
  const patchedUse = function (this: object, ...args: unknown[]): unknown {
    const result = (originalUse as (...useArgs: unknown[]) => unknown).apply(this, args);
    try {
      const subApps = flattenHandlers(args).filter(isExpressApp);
      if (subApps.length > 0) {
        const router = resolveAppRouter(this);
        if (router) {
          const pathTemplates = extractPathTemplates(args[0]) ?? ["/"];
          const table = tableFor(router);
          for (const subApp of subApps) {
            table.mounts.push({ pathTemplates, handler: subApp });
          }
        }
      }
    } catch (error) {
      logDebug(`Error capturing an express sub-app mount: ${String(error)}`);
    }
    return result;
  };
  (patchedUse as unknown as Record<PropertyKey, unknown>)[APP_USE_PATCH_MARKER] = true;
  (targetObject as Record<PropertyKey, unknown>).use = patchedUse;
}

// The wrapper adds a mount segment during the handler and removes it when next()
// returns control to the parent.
function wrapMountHandler(
  handler: unknown,
  pathTemplates: string[],
  table: RouterCaptureTable,
): unknown {
  if (typeof handler !== "function") {
    return handler;
  }
  table.mounts.push({ pathTemplates, handler });
  const stack = (handler as { stack?: unknown }).stack;
  if (Array.isArray(stack) && stack.length > 0 && !captureTables.has(handler as object)) {
    logWarning(
      'The routes of a mounted router were registered before Apitally could capture them, so requests to that router are exported without route templates. To resolve this, add `import "apitally/express/register";` as the first line of your application\'s entry module.',
    );
  }
  if (handler.length >= 4) {
    // Error middleware never descends into route dispatch.
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
    const parentBaseUrl = state.mountBaseUrls[state.mountBaseUrls.length - 1] ?? "";
    const consumedPath = baseUrl.startsWith(parentBaseUrl)
      ? baseUrl.slice(parentBaseUrl.length)
      : baseUrl;
    state.mountSegments.push(selectMatchingTemplate(pathTemplates, consumedPath));
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

function tableFor(router: object): RouterCaptureTable {
  let table = captureTables.get(router);
  if (!table) {
    table = { routes: [], mounts: [] };
    captureTables.set(router, table);
  }
  return table;
}

// Calling route() on a minimal prototype object creates a Route for prototype
// discovery without registering a layer.
function createProbeRoute(routerPrototype: Record<PropertyKey, unknown>): object | undefined {
  try {
    const stub = Object.create(routerPrototype) as Record<string, unknown>;
    stub.caseSensitive = false;
    stub.strict = false;
    stub.stack = [];
    const route = (routerPrototype.route as (path: string) => unknown).call(stub, "/");
    return typeof route === "object" && route !== null ? route : undefined;
  } catch {
    return undefined;
  }
}

// A mounted Express sub-app carries routes on its own internal router. The shape
// check follows Express's sub-app detection in app.use.
function resolveSubAppRouter(handler: object): object | undefined {
  return isExpressApp(handler) ? resolveAppRouter(handler) : undefined;
}

function isExpressApp(value: unknown): boolean {
  const candidate = value as { handle?: unknown; set?: unknown } | null;
  return (
    typeof value === "function" &&
    typeof candidate?.handle === "function" &&
    typeof candidate?.set === "function"
  );
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
    // Existing _router or router properties may still expose the router.
  }
  if (typeof appObject._router === "function") {
    return appObject._router as object;
  }
  try {
    // Reading app.router throws on Express 4, where _router is used instead.
    return typeof appObject.router === "function" ? (appObject.router as object) : undefined;
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

// Express treats a first-position function, including one nested in arrays, as
// a use() call without a path.
function isHandlerFirstArgument(argument: unknown): boolean {
  let first = argument;
  while (Array.isArray(first) && first.length > 0) {
    first = first[0];
  }
  return typeof first === "function";
}

function flattenHandlers(args: unknown[]): unknown[] {
  return args.flat(Number.POSITIVE_INFINITY);
}

function selectMatchingTemplate(pathTemplates: string[], consumedPath: string): string {
  if (pathTemplates.length === 1) {
    return pathTemplates[0];
  }
  return (
    pathTemplates.find((template) => matchesTemplate(template, consumedPath, "full")) ??
    pathTemplates[0]
  );
}

// The dispatched route's registered path: arrays resolve to the member
// matching the request's remaining path, regular expressions have no template.
function resolveDispatchedRoutePath(routePath: unknown, requestUrl: unknown): string | undefined {
  if (typeof routePath === "string") {
    return normalizeInlineRegexParams(routePath);
  }
  if (Array.isArray(routePath)) {
    const templates = routePath
      .filter((path): path is string => typeof path === "string")
      .map(normalizeInlineRegexParams);
    const remainingPath = typeof requestUrl === "string" ? requestUrl.split("?")[0] : "";
    return (
      templates.find((template) => matchesTemplate(template, remainingPath, "full")) ?? templates[0]
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

// Express 4 inline parameter patterns are removed; Express 5 rejects this syntax
// at registration.
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

// Express template matching handles named parameters, wildcards, and optional
// groups. Unknown syntax remains permissive so valid routes are not cleared.
function matchesTemplate(template: string, path: string, mode: "full" | "prefix"): boolean {
  if (template === "/") {
    return path === "/" || path === "";
  }
  const key = `${mode} ${template}`;
  if (!compiledTemplatePatterns.has(key)) {
    const suffix = mode === "full" ? "/?$" : "(?:/|$)";
    try {
      compiledTemplatePatterns.set(
        key,
        new RegExp(`^${templateToRegExpSource(template)}${suffix}`, "i"),
      );
    } catch {
      compiledTemplatePatterns.set(key, undefined);
    }
  }
  const pattern = compiledTemplatePatterns.get(key);
  return pattern ? pattern.test(path) : true;
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
