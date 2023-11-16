import { RequestInfo, RequestsItem } from "./types";

export default class RequestLogger {
  private requestCounts: Map<string, number>;
  private responseTimes: Map<string, Map<number, number>>;

  constructor() {
    this.requestCounts = new Map<string, number>();
    this.responseTimes = new Map<string, Map<number, number>>();
  }

  private getKey(requestInfo: RequestInfo): string {
    return [
      requestInfo.consumer || "",
      requestInfo.method.toUpperCase(),
      requestInfo.path,
      requestInfo.statusCode,
    ].join("|");
  }

  logRequest(requestInfo: RequestInfo): void {
    const key = this.getKey(requestInfo);

    // Increment request count
    this.requestCounts.set(key, (this.requestCounts.get(key) || 0) + 1);

    // Log response time
    if (!this.responseTimes.has(key)) {
      this.responseTimes.set(key, new Map<number, number>());
    }
    const responseTimeMap = this.responseTimes.get(key)!;
    const responseTimeMsBin = Math.floor(requestInfo.responseTime / 10) * 10; // Rounded to nearest 10ms
    responseTimeMap.set(
      responseTimeMsBin,
      (responseTimeMap.get(responseTimeMsBin) || 0) + 1
    );
  }

  getAndResetRequests(): Array<RequestsItem> {
    const data: Array<any> = [];
    this.requestCounts.forEach((count, key) => {
      const [consumer, method, path, statusCodeStr] = key.split("|");
      const responseTimes =
        this.responseTimes.get(key) || new Map<number, number>();
      data.push({
        consumer: consumer || null,
        method,
        path,
        status_code: parseInt(statusCodeStr),
        request_count: count,
        response_times: Object.fromEntries(responseTimes),
      });
    });

    // Reset the counts and times
    this.requestCounts.clear();
    this.responseTimes.clear();

    return data;
  }
}
