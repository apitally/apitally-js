import { OutgoingHttpHeader } from "node:http";

export function parseContentLength(
  contentLength: OutgoingHttpHeader | undefined | null,
): number | undefined {
  if (contentLength === undefined || contentLength === null) {
    return undefined;
  }
  if (typeof contentLength === "number") {
    return contentLength;
  }
  if (typeof contentLength === "string") {
    const parsed = parseInt(contentLength);
    return isNaN(parsed) ? undefined : parsed;
  }
  if (Array.isArray(contentLength)) {
    return parseContentLength(contentLength[0]);
  }
  return undefined;
}

export function mergeHeaders(base: Headers, merge: Headers) {
  const mergedHeaders = new Headers(base);
  for (const [name, value] of merge)
    if (name === "set-cookie") mergedHeaders.append(name, value);
    else mergedHeaders.set(name, value);
  return mergedHeaders;
}
