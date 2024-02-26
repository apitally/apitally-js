import { Logger } from "./logging.js";

export type ApitallyConfig = {
  clientId: string;
  env?: string;
  openApiUrl?: string;
  appVersion?: string;
  logger?: Logger;
};

export type PathInfo = {
  method: string;
  path: string;
};

export type AppInfo = {
  paths: PathInfo[];
  versions: Record<string, string>;
  client: string;
};

export type AppInfoPayload = {
  instance_uuid: string;
  message_uuid: string;
} & AppInfo;

export type ConsumerMethodPath = {
  consumer?: string | null;
  method: string;
  path: string;
};

export type RequestInfo = ConsumerMethodPath & {
  statusCode: number;
  responseTime: number;
  requestSize?: string | number;
  responseSize?: string | number;
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

export type RequestsDataPayload = {
  time_offset: number;
  instance_uuid: string;
  message_uuid: string;
  requests: Array<RequestsItem>;
  validation_errors: Array<ValidationErrorsItem>;
};
