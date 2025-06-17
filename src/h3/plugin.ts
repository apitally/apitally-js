import { definePlugin, onError, onRequest, onResponse } from "h3";

import { ApitallyClient } from "../common/client.js";
import { ApitallyConfig } from "../common/types.js";
import { getAppInfo } from "./utils.js";

export const apitallyPlugin = definePlugin<ApitallyConfig>((h3, config) => {
  const client = new ApitallyClient(config);

  setTimeout(() => {
    client.setStartupData(getAppInfo(h3, config.appVersion));
  }, 1000);

  h3.use(
    onRequest((event) => {
      event.context["apitallyRequestStartTime"] = Date.now();
    }),
  );

  h3.use(
    onResponse((response, event) => {
      const startTime = event.context["apitallyRequestStartTime"] as number;
      const duration = Date.now() - startTime;
      console.log(
        `[${event.req.method}] ${event.url.pathname} ~> ${response.status} (${duration} ms)`,
      );
    }),
  );

  h3.use(
    onError((error, event) => {
      console.log(
        `[${event.req.method}] ${event.url.pathname} ~> ERROR: ${error}`,
      );
    }),
  );
});
