import axios, { AxiosError, AxiosInstance } from "axios";
import axiosRetry from "axios-retry";
import { randomUUID } from "crypto";

import { KeyRegistry } from "./keyRegistry";
import { Logger, getLogger } from "./logging";
import RequestLogger from "./requestLogger";
import {
  ApitallyConfig,
  AppInfo,
  AppInfoPayload,
  RequestsDataPayload,
} from "./types";
import { isValidClientId, isValidEnv } from "./utils";
import ValidationErrorLogger from "./validationErrorLogger";

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
  private appInfo?: AppInfo;
  private appInfoSent: boolean = false;
  private startedAt: number;
  private keysUpdated?: number;

  public requestLogger: RequestLogger;
  public validationErrorLogger: ValidationErrorLogger;
  public keyRegistry: KeyRegistry;
  public logger: Logger;

  constructor({
    clientId,
    env = "default",
    syncApiKeys = false,
    logger,
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
    this.requestLogger = new RequestLogger();
    this.validationErrorLogger = new ValidationErrorLogger();
    this.keyRegistry = new KeyRegistry();
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

    this.startSync();
    this.handleShutdown = this.handleShutdown.bind(this);
  }

  public static getInstance(): ApitallyClient {
    if (!ApitallyClient.instance) {
      throw new Error("Apitally client is not initialized");
    }
    return ApitallyClient.instance;
  }

  private getHubUrl(): string {
    const baseURL =
      process.env.APITALLY_HUB_BASE_URL || "https://hub.apitally.io";
    const version = "v1";
    return `${baseURL}/${version}/${this.clientId}/${this.env}`;
  }

  private startSync(): void {
    this.sync();
    this.syncIntervalId = setInterval(() => {
      this.sync();
    }, SYNC_INTERVAL);
  }

  private async sync(): Promise<void> {
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

  private stopSync(): void {
    if (this.syncIntervalId) {
      clearInterval(this.syncIntervalId);
    }
  }

  public async handleShutdown(): Promise<void> {
    this.stopSync();
    await this.sendRequestsData();
    ApitallyClient.instance = undefined;
  }

  public setAppInfo(appInfo: AppInfo): void {
    this.appInfo = appInfo;
    this.appInfoSent = false;
    this.sendAppInfo();
  }

  private async sendAppInfo(): Promise<void> {
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

  private async sendRequestsData(): Promise<void> {
    this.logger.debug("Sending requests data to Apitally Hub.");
    const newPayload: RequestsDataPayload = {
      time_offset: 0,
      instance_uuid: this.instanceUuid,
      message_uuid: randomUUID(),
      requests: this.requestLogger.getAndResetRequests(),
      validation_errors:
        this.validationErrorLogger.getAndResetValidationErrors(),
      api_key_usage: this.keyRegistry.getAndResetUsageCounts(),
    };
    this.requestsDataQueue.push([Date.now(), newPayload]);

    const failedItems = [];
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

  private async getKeys(): Promise<void> {
    try {
      this.logger.debug("Getting API keys from Apitally Hub.");
      const response = await this.axiosClient.get("/keys");
      this.keyRegistry.salt = response.data.salt || null;
      this.keyRegistry.update(response.data.keys || {});
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
}
