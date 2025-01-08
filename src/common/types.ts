import { Logger } from "./logging.js";
import { RequestLoggingConfig } from "./requestLogger.js";

export type ApitallyConfig = {
  clientId: string;
  env?: string;
  requestLoggingConfig?: Partial<RequestLoggingConfig>;
  openApiUrl?: string;
  appVersion?: string;
  logger?: Logger;
};

export type ApitallyConsumer = {
  identifier: string;
  name?: string | null;
  group?: string | null;
};

export type PathInfo = {
  method: string;
  path: string;
};

export type StartupData = {
  paths: PathInfo[];
  versions: Record<string, string>;
  client: string;
};

export type StartupPayload = {
  instance_uuid: string;
  message_uuid: string;
} & StartupData;

export type ConsumerMethodPath = {
  consumer?: string | null;
  method: string;
  path: string;
};

export type RequestInfo = ConsumerMethodPath & {
  statusCode: number;
  responseTime: number;
  requestSize?: string | number | null;
  responseSize?: string | number | null;
};

export type RequestsItem = ConsumerMethodPath & {
  status_code: number;
  request_count: number;
  request_size_sum: number;
  response_size_sum: number;
  response_times: Record<number, number>;
  request_sizes: Record<number, number>;
  response_sizes: Record<number, number>;
};

export type ValidationError = {
  loc: string;
  msg: string;
  type: string;
};

export type ValidationErrorsItem = ConsumerMethodPath & {
  loc: Array<string>;
  msg: string;
  type: string;
  error_count: number;
};

export type ServerError = {
  type: string;
  msg: string;
  traceback: string;
};

export type ServerErrorsItem = ConsumerMethodPath & {
  type: string;
  msg: string;
  traceback: string;
  sentry_event_id: string | null;
  error_count: number;
};

export type ConsumerItem = ApitallyConsumer;

export type SyncPayload = {
  timestamp: number;
  instance_uuid: string;
  message_uuid: string;
  requests: Array<RequestsItem>;
  validation_errors: Array<ValidationErrorsItem>;
  server_errors: Array<ServerErrorsItem>;
  consumers: Array<ConsumerItem>;
};
