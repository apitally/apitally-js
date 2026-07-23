export interface ApitallyConsumer {
  identifier: string;
  name?: string;
  group?: string;
}

export function consumerFromStringOrObject(
  consumer: ApitallyConsumer | string | number | null | undefined,
): ApitallyConsumer | undefined {
  if (typeof consumer === "object" && consumer !== null) {
    const identifier = trimAndCap(consumer.identifier, 128);
    if (!identifier) {
      return undefined;
    }
    return {
      identifier,
      name: trimAndCap(consumer.name, 64),
      group: trimAndCap(consumer.group, 64),
    };
  }
  const identifier = trimAndCap(consumer, 128);
  return identifier ? { identifier } : undefined;
}

function trimAndCap(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") {
    return undefined;
  }
  return String(value).trim().slice(0, maxLength) || undefined;
}
