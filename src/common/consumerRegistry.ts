import { ApitallyConsumer } from "./types.js";

export const consumerFromStringOrObject = (
  consumer: ApitallyConsumer | string,
) => {
  if (typeof consumer === "string") {
    consumer = String(consumer).trim().substring(0, 128);
    return consumer ? { identifier: consumer } : null;
  } else {
    consumer.identifier = String(consumer.identifier).trim().substring(0, 128);
    consumer.name = consumer.name?.trim().substring(0, 64);
    consumer.group = consumer.group?.trim().substring(0, 64);
    return consumer.identifier ? consumer : null;
  }
};

export default class ConsumerRegistry {
  private consumers: Map<string, ApitallyConsumer>;
  private updated: Set<string>;

  constructor() {
    this.consumers = new Map();
    this.updated = new Set();
  }

  public addOrUpdateConsumer(consumer?: ApitallyConsumer | null) {
    if (!consumer || (!consumer.name && !consumer.group)) {
      return;
    }
    const existing = this.consumers.get(consumer.identifier);
    if (!existing) {
      this.consumers.set(consumer.identifier, consumer);
      this.updated.add(consumer.identifier);
    } else {
      if (consumer.name && consumer.name !== existing.name) {
        existing.name = consumer.name;
        this.updated.add(consumer.identifier);
      }
      if (consumer.group && consumer.group !== existing.group) {
        existing.group = consumer.group;
        this.updated.add(consumer.identifier);
      }
    }
  }

  public getAndResetUpdatedConsumers() {
    const data: Array<ApitallyConsumer> = [];
    this.updated.forEach((identifier) => {
      const consumer = this.consumers.get(identifier);
      if (consumer) {
        data.push(consumer);
      }
    });
    this.updated.clear();
    return data;
  }
}
