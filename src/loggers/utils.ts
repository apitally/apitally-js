import { format } from "node:util";

export function formatMessage(message: any, ...args: any[]) {
  return [message, ...args]
    .map(formatArg)
    .filter((arg) => arg !== "")
    .join("\n");
}

export function removeKeys(obj: any, keys: string[]) {
  return Object.fromEntries(
    Object.entries(obj).filter(([key]) => !keys.includes(key)),
  );
}

function formatArg(arg: any) {
  if (typeof arg === "string") {
    return arg.trim();
  }
  if (arg instanceof Error) {
    return format(arg).trim();
  }
  if (arg === undefined || arg === null || isEmptyObject(arg)) {
    return "";
  }
  try {
    return JSON.stringify(arg);
  } catch {
    return format(arg).trim();
  }
}

function isEmptyObject(obj: any) {
  return (
    obj !== null &&
    typeof obj === "object" &&
    Object.getPrototypeOf(obj) === Object.prototype &&
    Object.keys(obj).length === 0
  );
}
