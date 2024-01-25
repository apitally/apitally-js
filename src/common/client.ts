import axios, { AxiosError, AxiosInstance } from "axios";
import axiosRetry from "axios-retry";
import { randomUUID } from "crypto";

import { KeyCacheBase, KeyRegistry } from "./keyRegistry.js";
import { Logger, getLogger } from "./logging.js";
import { isValidClientId, isValidEnv } from "./paramValidation.js";
import RequestCounter from "./requestCounter.js";
import {
  ApitallyConfig,
  AppInfo,
  AppInfoPayload,
  RequestsDataPayload,
} from "./types.js";
import ValidationErrorCounter from "./validationErrorCounter.js";

const SYNC_INTERVAL = 60000; // 60 seconds
const REQUEST_TIMEOUT = 10000; // 10 seconds
const MAX_QUEUE_TIME = 3.6e6; // 1 hour

export class ApitallyClient {
  private clientId: string;
  private env: string;
  private syncApiKeys: boolean;

  private static instance?: ApitallyClient;
  private instanceUuid: string;
  private requestsDataQueue: Array<[number, RequestsDataPayload]>;
  private axiosClient: AxiosInstance;
  private syncIntervalId?: NodeJS.Timeout;
  public appInfo?: AppInfo;
  private appInfoSent: boolean = false;
  private startedAt: number;
  private keysUpdated?: number;

  public requestCounter: RequestCounter;
  public validationErrorCounter: ValidationErrorCounter;
  public keyRegistry: KeyRegistry;
  public keyCache?: KeyCacheBase;
  public logger: Logger;

  constructor({
    clientId,
    env = "dev",
    syncApiKeys = false,
    logger,
    keyCacheClass,
  }: ApitallyConfig) {
    if (ApitallyClient.instance) {
      throw new Error("Apitally client is already initialized");
    }
    if (!isValidClientId(clientId)) {
      throw new Error(
        `Invalid client ID '${clientId}' (expecting hexadeciaml UUID format)`,
      );
    }
    if (!isValidEnv(env)) {
      throw new Error(
        `Invalid env '${env}' (expecting 1-32 alphanumeric lowercase characters and hyphens only)`,
      );
    }

    ApitallyClient.instance = this;
    this.clientId = clientId;
    this.env = env;
    this.syncApiKeys = syncApiKeys;
    this.instanceUuid = randomUUID();
    this.requestsDataQueue = [];
    this.startedAt = Date.now();
    this.requestCounter = new RequestCounter();
    this.validationErrorCounter = new ValidationErrorCounter();
    this.keyRegistry = new KeyRegistry();
    this.keyCache = keyCacheClass
      ? new keyCacheClass(clientId, env)
      : undefined;
    this.logger = logger || getLogger();

    this.axiosClient = axios.create({
      baseURL: this.getHubUrl(),
      timeout: REQUEST_TIMEOUT,
    });
    axiosRetry(this.axiosClient, {
      retries: 3,
      retryDelay: (retryCount, error) =>
        axiosRetry.exponentialDelay(retryCount, error, 1000),
    });

    if (this.keyCache) {
      const keyDataString = this.keyCache.retrieve();
      if (keyDataString) {
        try {
          const keyData = JSON.parse(keyDataString);
          this.updateKeyRegistry(keyData, false);
        } catch (error) {
          this.logger.error("Failed to load API keys from cache.", { error });
        }
      }
    }

    this.startSync();
    this.handleShutdown = this.handleShutdown.bind(this);
  }

  public static getInstance() {
    if (!ApitallyClient.instance) {
      throw new Error("Apitally client is not initialized");
    }
    return ApitallyClient.instance;
  }

  public static async shutdown() {
    if (ApitallyClient.instance) {
      await ApitallyClient.instance.handleShutdown();
    }
  }

  public async handleShutdown() {
    this.stopSync();
    await this.sendRequestsData();
    ApitallyClient.instance = undefined;
  }

  private getHubUrl() {
    const baseURL =
      process.env.APITALLY_HUB_BASE_URL || "https://hub.apitally.io";
    const version = "v1";
    return `${baseURL}/${version}/${this.clientId}/${this.env}`;
  }

  private startSync() {
    this.sync();
    this.syncIntervalId = setInterval(() => {
      this.sync();
    }, SYNC_INTERVAL);
  }

  private async sync() {
    try {
      const promises = [this.sendRequestsData()];
      if (this.syncApiKeys) {
        promises.push(this.getKeys());
      }
      if (!this.appInfoSent) {
        promises.push(this.sendAppInfo());
      }
      await Promise.all(promises);
    } catch (error) {
      this.logger.error("Error while syncing with Apitally Hub.", {
        error,
      });
    }
  }

  private stopSync() {
    if (this.syncIntervalId) {
      clearInterval(this.syncIntervalId);
      this.syncIntervalId = undefined;
    }
  }

  public setAppInfo(appInfo: AppInfo) {
    this.appInfo = appInfo;
    this.appInfoSent = false;
    this.sendAppInfo();
  }

  private async sendAppInfo() {
    if (this.appInfo) {
      this.logger.debug("Sending app info to Apitally Hub.");
      const payload: AppInfoPayload = {
        instance_uuid: this.instanceUuid,
        message_uuid: randomUUID(),
        ...this.appInfo,
      };
      try {
        await this.axiosClient.post("/info", payload);
        this.appInfoSent = true;
      } catch (error) {
        if (
          error instanceof AxiosError &&
          error.response &&
          error.response.status === 404 &&
          error.response.data &&
          typeof error.response.data === "string" &&
          error.response.data.includes("Client ID")
        ) {
          this.logger.error(`Invalid Apitally client ID '${this.clientId}'.`);
          this.stopSync();
        } else {
          this.logger.debug(
            `Error while sending app info to Apitally Hub (${
              (error as AxiosError).code
            }). Will retry.`,
            { error },
          );
        }
      }
    }
  }

  private async sendRequestsData() {
    this.logger.debug("Sending requests data to Apitally Hub.");
    const newPayload: RequestsDataPayload = {
      time_offset: 0,
      instance_uuid: this.instanceUuid,
      message_uuid: randomUUID(),
      requests: this.requestCounter.getAndResetRequests(),
      validation_errors:
        this.validationErrorCounter.getAndResetValidationErrors(),
      api_key_usage: this.keyRegistry.getAndResetUsageCounts(),
    };
    this.requestsDataQueue.push([Date.now(), newPayload]);

    const failedItems: [number, RequestsDataPayload][] = [];
    while (this.requestsDataQueue.length > 0) {
      const queueItem = this.requestsDataQueue.shift();
      if (queueItem) {
        const [time, payload] = queueItem;
        try {
          const timeOffset = Date.now() - time;
          if (timeOffset <= MAX_QUEUE_TIME) {
            payload.time_offset = timeOffset / 1000.0; // In seconds
            await this.axiosClient.post("/requests", payload);
          }
        } catch (error) {
          this.logger.debug(
            `Error while sending requests data to Apitally Hub (${
              (error as AxiosError).code
            }). Will retry.`,
            { error },
          );
          failedItems.push(queueItem);
        }
      }
    }
    this.requestsDataQueue = failedItems;
  }

  private async getKeys() {
    try {
      this.logger.debug("Getting API keys from Apitally Hub.");
      const response = await this.axiosClient.get("/keys");
      this.updateKeyRegistry(response.data);
      this.keysUpdated = Date.now();
    } catch (error) {
      this.logger.debug(
        `Error while getting API keys from Apitally Hub (${
          (error as AxiosError).code
        }). Will retry.`,
        { error },
      );
      const now = Date.now();
      if (!this.keyRegistry.salt) {
        // Exit because application won't be able to authenticate requests
        this.logger.error("Initial Apitally API key sync failed.");
        process.exit(1);
      } else if (
        (this.keysUpdated && now - this.keysUpdated > MAX_QUEUE_TIME) ||
        (!this.keysUpdated && now - this.startedAt > MAX_QUEUE_TIME)
      ) {
        this.logger.warn(
          "Apitally API key sync has been failing for more than 1 hour.",
        );
      }
    }
  }

  private updateKeyRegistry(data: any, cache: boolean = true) {
    this.keyRegistry.salt = data.salt || null;
    this.keyRegistry.update(data.keys || {});

    if (cache && this.keyCache) {
      this.keyCache.store(JSON.stringify(data));
    }
  }
}
