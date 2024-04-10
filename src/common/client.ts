import axios, { AxiosError, AxiosInstance } from "axios";
import axiosRetry from "axios-retry";
import { randomUUID } from "crypto";

import { Logger, getLogger } from "./logging.js";
import { isValidClientId, isValidEnv } from "./paramValidation.js";
import RequestCounter from "./requestCounter.js";
import ServerErrorCounter from "./serverErrorCounter.js";
import {
  ApitallyConfig,
  AppInfo,
  AppInfoPayload,
  RequestsDataPayload,
} from "./types.js";
import ValidationErrorCounter from "./validationErrorCounter.js";

const SYNC_INTERVAL = 60000; // 60 seconds
const INITIAL_SYNC_INTERVAL = 10000; // 10 seconds
const INITIAL_SYNC_INTERVAL_DURATION = 3600000; // 1 hour
const REQUEST_TIMEOUT = 10000; // 10 seconds
const MAX_QUEUE_TIME = 3.6e6; // 1 hour

export class ApitallyClient {
  private clientId: string;
  private env: string;

  private static instance?: ApitallyClient;
  private instanceUuid: string;
  private requestsDataQueue: Array<[number, RequestsDataPayload]>;
  private axiosClient: AxiosInstance;
  private syncIntervalId?: NodeJS.Timeout;
  public appInfo?: AppInfo;
  private appInfoSent: boolean = false;

  public requestCounter: RequestCounter;
  public validationErrorCounter: ValidationErrorCounter;
  public serverErrorCounter: ServerErrorCounter;
  public logger: Logger;

  constructor({ clientId, env = "dev", logger }: ApitallyConfig) {
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
    this.instanceUuid = randomUUID();
    this.requestsDataQueue = [];
    this.requestCounter = new RequestCounter();
    this.validationErrorCounter = new ValidationErrorCounter();
    this.serverErrorCounter = new ServerErrorCounter();
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
    }, INITIAL_SYNC_INTERVAL);
    setTimeout(() => {
      clearInterval(this.syncIntervalId);
      this.syncIntervalId = setInterval(() => {
        this.sync();
      }, SYNC_INTERVAL);
    }, INITIAL_SYNC_INTERVAL_DURATION);
  }

  private async sync() {
    try {
      const promises = [this.sendRequestsData()];
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
      server_errors: this.serverErrorCounter.getAndResetServerErrors(),
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
}
