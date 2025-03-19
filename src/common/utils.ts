import { OutgoingHttpHeader } from "http";

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
