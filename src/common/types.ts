import { KeyCacheBase } from "./keyRegistry";
import { Logger } from "./logging";

export type ApitallyConfig = {
  clientId: string;
  env?: string;
  syncApiKeys?: boolean;
  openApiUrl?: string;
  appVersion?: string;
  logger?: Logger;
  keyCacheClass?: new (clientId: string, env: string) => KeyCacheBase;
};

export type PathInfo = {
  method: string;
  path: string;
};

export type AppInfo = {
  paths: Array<PathInfo>;
  versions: Map<string, string>;
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
};

export type RequestsItem = ConsumerMethodPath & {
  status_code: number;
  request_count: number;
  response_times: Record<number, number>;
};

export type ValidationError = {
  loc: string;
  msg: string;
  type: string;
};

export type ValidationErrorsItem = ConsumerMethodPath & {
  loc: Array<string>;
  error_count: number;
} & ValidationError;

export type RequestsDataPayload = {
  time_offset: number;
  instance_uuid: string;
  message_uuid: string;
  requests: Array<RequestsItem>;
  validation_errors: Array<ValidationErrorsItem>;
  api_key_usage: Record<number, number>;
};
