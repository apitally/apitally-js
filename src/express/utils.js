// Adapted from https://github.com/AlbertoFdzM/express-list-endpoints/blob/305535d43008b46f34e18b01947762e039af6d2d/src/index.js
// and also incorporated https://github.com/AlbertoFdzM/express-list-endpoints/pull/96
// and https://github.com/labithiotis/express-list-routes/blob/5432c83a67c2788c56a1cdfc067ec809961c0c05/index.js

/**
 * @typedef {Object} Route
 * @property {Object} methods
 * @property {string | string[]} path
 * @property {any[]} stack
 *
 * @typedef {Object} Endpoint
 * @property {string} path Path name
 * @property {string[]} methods Methods handled
 * @property {string[]} middlewares Mounted middlewares
 */

const regExpToParseExpressPathRegExp =
  /^\/\^\\?\/?(?:(:?[\w\\.-]*(?:\\\/:?[\w\\.-]*)*)|(\(\?:\\?\/?\([^)]+\)\)))\\\/.*/;
const regExpToReplaceExpressPathRegExpParams = /\(\?:\\?\/?\([^)]+\)\)/;
const regexpExpressParamRegexp = /\(\?:\\?\\?\/?\([^)]+\)\)/g;
const regexpExpressPathParamRegexp = /(:[^)]+)\([^)]+\)/g;

const EXPRESS_ROOT_PATH_REGEXP_VALUE = "/^\\/?(?=\\/|$)/i";
const STACK_ITEM_VALID_NAMES = ["router", "bound dispatch", "mounted_app"];

/**
 * Detects Express version and returns router information
 * @param {import('express').Express | import('express').Router | any} app
 * @returns {{stack: any[] | null, version: 'v4' | 'v5'}}
 */
export const getRouterInfo = function (app) {
  if (app.stack) {
    // Express 4 router
    return { stack: app.stack, version: "v4" };
  } else if (app._router && app._router.stack) {
    // Express 4
    return { stack: app._router.stack, version: "v4" };
  } else if (app.router && app.router.stack) {
    // Express 5
    return { stack: app.router.stack, version: "v5" };
  }
  return { stack: null, version: "v4" };
};

/**
 * Returns all the verbs detected for the passed route
 * @param {Route} route
 */
const getRouteMethods = function (route) {
  let methods = Object.keys(route.methods);

  methods = methods.filter((method) => method !== "_all");
  methods = methods.map((method) => method.toUpperCase());

  return methods;
};

/**
 * Returns the names (or anonymous) of all the middlewares attached to the
 * passed route
 * @param {Route} route
 * @returns {string[]}
 */
const getRouteMiddlewares = function (route) {
  return route.stack.map((item) => {
    return item.handle.name || "anonymous";
  });
};

/**
 * Returns true if found regexp related with express params
 * @param {string} expressPathRegExp
 * @returns {boolean}
 */
const hasParams = function (expressPathRegExp) {
  return regexpExpressParamRegexp.test(expressPathRegExp);
};

/**
 * @param {Route} route Express route object to be parsed
 * @param {string} basePath The basePath the route is on
 * @return {Endpoint[]} Endpoints info
 */
const parseExpressRoute = function (route, basePath) {
  const paths = [];

  if (Array.isArray(route.path)) {
    paths.push(...route.path);
  } else {
    paths.push(route.path);
  }

  /** @type {Endpoint[]} */
  const endpoints = paths.map((path) => {
    const completePath =
      basePath && path === "/" ? basePath : `${basePath}${path}`;

    /** @type {Endpoint} */
    const endpoint = {
      path: completePath.replace(regexpExpressPathParamRegexp, "$1"),
      methods: getRouteMethods(route),
      middlewares: getRouteMiddlewares(route),
    };

    return endpoint;
  });

  return endpoints;
};

/**
 * @param {RegExp} expressPathRegExp
 * @param {any[]} keys
 * @returns {string}
 */
export const parseExpressPathRegExp = function (expressPathRegExp, keys) {
  let parsedRegExp = expressPathRegExp.toString();
  let expressPathRegExpExec = regExpToParseExpressPathRegExp.exec(parsedRegExp);
  let paramIndex = 0;

  while (hasParams(parsedRegExp)) {
    const paramName = keys[paramIndex].name;
    const paramId = `:${paramName}`;

    parsedRegExp = parsedRegExp.replace(
      regExpToReplaceExpressPathRegExpParams,
      (str) => {
        // Express >= 4.20.0 uses a different RegExp for parameters: it
        // captures the slash as part of the parameter. We need to check
        // for this case and add the slash to the value that will replace
        // the parameter in the path.
        if (str.startsWith("(?:\\/")) {
          return `\\/${paramId}`;
        }

        return paramId;
      },
    );

    paramIndex++;
  }

  if (parsedRegExp !== expressPathRegExp.toString()) {
    expressPathRegExpExec = regExpToParseExpressPathRegExp.exec(parsedRegExp);
  }

  return expressPathRegExpExec[1].replace(/\\\//g, "/");
};

/**
 * @param {string} expressPath
 * @param {Object.<string, string>} params
 * @returns {string}
 */
export const parseExpressPath = function (expressPath, params) {
  let result = expressPath;
  for (const [paramName, paramValue] of Object.entries(params)) {
    result = result.replace(paramValue, `:${paramName}`);
  }
  return result;
};

/**
 * @param {import('express').Express | import('express').Router | any} app
 * @param {string} [basePath]
 * @param {Endpoint[]} [endpoints]
 * @returns {Endpoint[]}
 */
const parseEndpoints = function (app, basePath, endpoints) {
  const routerInfo = getRouterInfo(app);
  const stack = routerInfo.stack;
  const version = routerInfo.version;

  endpoints = endpoints || [];
  basePath = basePath || "";

  if (!stack) {
    if (endpoints.length) {
      endpoints = addEndpoints(endpoints, [
        {
          path: basePath,
          methods: [],
          middlewares: [],
        },
      ]);
    }
  } else {
    endpoints = parseStack(stack, basePath, endpoints, version);
  }

  return endpoints;
};

/**
 * Ensures the path of the new endpoints isn't yet in the array.
 * If the path is already in the array merges the endpoints with the existing
 * one, if not, it adds them to the array.
 *
 * @param {Endpoint[]} currentEndpoints Array of current endpoints
 * @param {Endpoint[]} endpointsToAdd New endpoints to be added to the array
 * @returns {Endpoint[]} Updated endpoints array
 */
const addEndpoints = function (currentEndpoints, endpointsToAdd) {
  endpointsToAdd.forEach((newEndpoint) => {
    const existingEndpoint = currentEndpoints.find(
      (endpoint) => endpoint.path === newEndpoint.path,
    );

    if (existingEndpoint !== undefined) {
      const newMethods = newEndpoint.methods.filter(
        (method) => !existingEndpoint.methods.includes(method),
      );

      existingEndpoint.methods = existingEndpoint.methods.concat(newMethods);
    } else {
      currentEndpoints.push(newEndpoint);
    }
  });

  return currentEndpoints;
};

/**
 * @param {any[]} stack
 * @param {string} basePath
 * @param {Endpoint[]} endpoints
 * @param {'v4' | 'v5'} [version]
 * @returns {Endpoint[]}
 */
const parseStack = function (stack, basePath, endpoints, version) {
  stack.forEach((stackItem) => {
    if (stackItem.route) {
      const newEndpoints = parseExpressRoute(stackItem.route, basePath);

      endpoints = addEndpoints(endpoints, newEndpoints);
    } else if (STACK_ITEM_VALID_NAMES.includes(stackItem.name)) {
      let newBasePath = basePath;

      if (version === "v4") {
        const isExpressPathRegExp = regExpToParseExpressPathRegExp.test(
          stackItem.regexp,
        );
        if (isExpressPathRegExp) {
          const parsedPath = parseExpressPathRegExp(
            stackItem.regexp,
            stackItem.keys,
          );
          newBasePath += `/${parsedPath}`;
        } else if (
          !stackItem.path &&
          stackItem.regexp &&
          stackItem.regexp.toString() !== EXPRESS_ROOT_PATH_REGEXP_VALUE
        ) {
          const regExpPath = ` RegExp(${stackItem.regexp}) `;
          newBasePath += `/${regExpPath}`;
        }
      } else if (version === "v5") {
        if (!stackItem.path) {
          return;
        } else if (stackItem.path !== "/") {
          newBasePath += `/${stackItem.path}`;
        }
      }

      endpoints = parseEndpoints(stackItem.handle, newBasePath, endpoints);
    }
  });

  return endpoints;
};

export const getEndpoints = function (app, basePath) {
  const endpoints = parseEndpoints(app);
  return endpoints.flatMap((route) =>
    route.methods
      .filter((method) => !["HEAD", "OPTIONS"].includes(method.toUpperCase()))
      .map((method) => ({
        method,
        path: (basePath + route.path).replace(/\/\//g, "/"),
      })),
  );
};
