import { RequestInfo, RequestsItem } from "./types.js";

export default class RequestCounter {
  private requestCounts: Map<string, number>;
  private requestSizeSums: Map<string, number>;
  private responseSizeSums: Map<string, number>;
  private responseTimes: Map<string, Map<number, number>>;
  private requestSizes: Map<string, Map<number, number>>;
  private responseSizes: Map<string, Map<number, number>>;

  constructor() {
    this.requestCounts = new Map<string, number>();
    this.requestSizeSums = new Map<string, number>();
    this.responseSizeSums = new Map<string, number>();
    this.responseTimes = new Map<string, Map<number, number>>();
    this.requestSizes = new Map<string, Map<number, number>>();
    this.responseSizes = new Map<string, Map<number, number>>();
  }

  private getKey(requestInfo: RequestInfo) {
    return [
      requestInfo.consumer || "",
      requestInfo.method.toUpperCase(),
      requestInfo.path,
      requestInfo.statusCode,
    ].join("|");
  }

  addRequest(requestInfo: RequestInfo) {
    const key = this.getKey(requestInfo);

    // Increment request count
    this.requestCounts.set(key, (this.requestCounts.get(key) || 0) + 1);

    // Add response time
    if (!this.responseTimes.has(key)) {
      this.responseTimes.set(key, new Map<number, number>());
    }
    const responseTimeMap = this.responseTimes.get(key)!;
    const responseTimeMsBin = Math.floor(requestInfo.responseTime / 10) * 10; // Rounded to nearest 10ms
    responseTimeMap.set(
      responseTimeMsBin,
      (responseTimeMap.get(responseTimeMsBin) || 0) + 1,
    );

    // Add request size
    if (requestInfo.requestSize !== undefined) {
      requestInfo.requestSize = Number(requestInfo.requestSize);
      this.requestSizeSums.set(
        key,
        (this.requestSizeSums.get(key) || 0) + requestInfo.requestSize,
      );
      if (!this.requestSizes.has(key)) {
        this.requestSizes.set(key, new Map<number, number>());
      }
      const requestSizeMap = this.requestSizes.get(key)!;
      const requestSizeKbBin = Math.floor(requestInfo.requestSize / 1000); // Rounded down to nearest KB
      requestSizeMap.set(
        requestSizeKbBin,
        (requestSizeMap.get(requestSizeKbBin) || 0) + 1,
      );
    }

    // Add response size
    if (requestInfo.responseSize !== undefined) {
      requestInfo.responseSize = Number(requestInfo.responseSize);
      this.responseSizeSums.set(
        key,
        (this.responseSizeSums.get(key) || 0) + requestInfo.responseSize,
      );
      if (!this.responseSizes.has(key)) {
        this.responseSizes.set(key, new Map<number, number>());
      }
      const responseSizeMap = this.responseSizes.get(key)!;
      const responseSizeKbBin = Math.floor(requestInfo.responseSize / 1000); // Rounded down to nearest KB
      responseSizeMap.set(
        responseSizeKbBin,
        (responseSizeMap.get(responseSizeKbBin) || 0) + 1,
      );
    }
  }

  getAndResetRequests() {
    const data: Array<RequestsItem> = [];
    this.requestCounts.forEach((count, key) => {
      const [consumer, method, path, statusCodeStr] = key.split("|");
      const responseTimes =
        this.responseTimes.get(key) || new Map<number, number>();
      const requestSizes =
        this.requestSizes.get(key) || new Map<number, number>();
      const responseSizes =
        this.responseSizes.get(key) || new Map<number, number>();
      data.push({
        consumer: consumer || null,
        method,
        path,
        status_code: parseInt(statusCodeStr),
        request_count: count,
        request_size_sum: this.requestSizeSums.get(key) || 0,
        response_size_sum: this.responseSizeSums.get(key) || 0,
        response_times: Object.fromEntries(responseTimes),
        request_sizes: Object.fromEntries(requestSizes),
        response_sizes: Object.fromEntries(responseSizes),
      });
    });

    // Reset the counts and times
    this.requestCounts.clear();
    this.requestSizeSums.clear();
    this.responseSizeSums.clear();
    this.responseTimes.clear();
    this.requestSizes.clear();
    this.responseSizes.clear();

    return data;
  }
}
