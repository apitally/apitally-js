import { randomUUID } from "crypto";
import fetchRetry from "fetch-retry";
import ConsumerRegistry from "./consumerRegistry.js";
import { Logger, getLogger } from "./logging.js";
import { isValidClientId, isValidEnv } from "./paramValidation.js";
import RequestCounter from "./requestCounter.js";
import ServerErrorCounter from "./serverErrorCounter.js";
import {
  ApitallyConfig,
  StartupData,
  StartupPayload,
  SyncPayload,
} from "./types.js";
import ValidationErrorCounter from "./validationErrorCounter.js";

const SYNC_INTERVAL = 60000; // 60 seconds
const INITIAL_SYNC_INTERVAL = 10000; // 10 seconds
const INITIAL_SYNC_INTERVAL_DURATION = 3600000; // 1 hour
const MAX_QUEUE_TIME = 3.6e6; // 1 hour

class HTTPError extends Error {
  public response: Response;

  constructor(response: Response) {
    const reason = response.status
      ? `status code ${response.status}`
      : "an unknown error";
    super(`Request failed with ${reason}`);
    this.response = response;
  }
}

export class ApitallyClient {
  private clientId: string;
  private env: string;

  private static instance?: ApitallyClient;
  private instanceUuid: string;
  private syncDataQueue: Array<[number, SyncPayload]>;
  private syncIntervalId?: NodeJS.Timeout;
  public startupData?: StartupData;
  private startupDataSent: boolean = false;

  public requestCounter: RequestCounter;
  public validationErrorCounter: ValidationErrorCounter;
  public serverErrorCounter: ServerErrorCounter;
  public consumerRegistry: ConsumerRegistry;
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
    this.syncDataQueue = [];
    this.requestCounter = new RequestCounter();
    this.validationErrorCounter = new ValidationErrorCounter();
    this.serverErrorCounter = new ServerErrorCounter();
    this.consumerRegistry = new ConsumerRegistry();
    this.logger = logger || getLogger();

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
    await this.sendSyncData();
    ApitallyClient.instance = undefined;
  }

  private getHubUrlPrefix() {
    const baseURL =
      process.env.APITALLY_HUB_BASE_URL || "https://hub.apitally.io";
    const version = "v2";
    return `${baseURL}/${version}/${this.clientId}/${this.env}/`;
  }

  private async sendData(url: string, payload: any) {
    const fetchWithRetry = fetchRetry(fetch, {
      retries: 3,
      retryDelay: 1000,
      retryOn: [408, 429, 500, 502, 503, 504],
    });
    const response = await fetchWithRetry(this.getHubUrlPrefix() + url, {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
    });
    if (!response.ok) {
      throw new HTTPError(response);
    }
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
      const promises = [this.sendSyncData()];
      if (!this.startupDataSent) {
        promises.push(this.sendStartupData());
      }
      await Promise.all(promises);
    } catch (error) {
      this.logger.error("Error while syncing with Apitally Hub", {
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

  public setStartupData(data: StartupData) {
    this.startupData = data;
    this.startupDataSent = false;
    this.sendStartupData();
  }

  private async sendStartupData() {
    if (this.startupData) {
      this.logger.debug("Sending startup data to Apitally Hub");
      const payload: StartupPayload = {
        instance_uuid: this.instanceUuid,
        message_uuid: randomUUID(),
        ...this.startupData,
      };
      try {
        await this.sendData("startup", payload);
        this.startupDataSent = true;
      } catch (error) {
        const handled = this.handleHubError(error);
        if (!handled) {
          this.logger.error((error as Error).message);
          this.logger.debug(
            "Error while sending startup data to Apitally Hub (will retry)",
            { error },
          );
        }
      }
    }
  }

  private async sendSyncData() {
    this.logger.debug("Synchronizing data with Apitally Hub");
    const newPayload: SyncPayload = {
      time_offset: 0,
      instance_uuid: this.instanceUuid,
      message_uuid: randomUUID(),
      requests: this.requestCounter.getAndResetRequests(),
      validation_errors:
        this.validationErrorCounter.getAndResetValidationErrors(),
      server_errors: this.serverErrorCounter.getAndResetServerErrors(),
      consumers: this.consumerRegistry.getAndResetUpdatedConsumers(),
    };
    this.syncDataQueue.push([Date.now(), newPayload]);

    const failedItems: [number, SyncPayload][] = [];
    while (this.syncDataQueue.length > 0) {
      const queueItem = this.syncDataQueue.shift();
      if (queueItem) {
        const [time, payload] = queueItem;
        try {
          const timeOffset = Date.now() - time;
          if (timeOffset <= MAX_QUEUE_TIME) {
            payload.time_offset = timeOffset / 1000.0; // In seconds
            await this.sendData("sync", payload);
          }
        } catch (error) {
          const handled = this.handleHubError(error);
          if (!handled) {
            this.logger.debug(
              "Error while synchronizing data with Apitally Hub (will retry)",
              { error },
            );
            failedItems.push(queueItem);
          }
        }
      }
    }
    this.syncDataQueue = failedItems;
  }

  private handleHubError(error: unknown) {
    if (error instanceof HTTPError) {
      if (error.response.status === 404) {
        this.logger.error(`Invalid Apitally client ID: '${this.clientId}'`);
        this.stopSync();
        return true;
      }
      if (error.response.status === 422) {
        this.logger.error("Received validation error from Apitally Hub");
        return true;
      }
    }
    return false;
  }
}
