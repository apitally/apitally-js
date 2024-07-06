import { describe, expect, it } from "vitest";

import ConsumerRegistry, {
  consumerFromStringOrObject,
} from "../../src/common/consumerRegistry";

describe("Consumer registry", () => {
  it("Consumer from string or object", () => {
    let consumer = consumerFromStringOrObject("");
    expect(consumer).toBeNull();

    consumer = consumerFromStringOrObject({ identifier: " " });
    expect(consumer).toBeNull();

    consumer = consumerFromStringOrObject("test");
    expect(consumer).toEqual({
      identifier: "test",
    });

    consumer = consumerFromStringOrObject({ identifier: "test" });
    expect(consumer).toEqual({
      identifier: "test",
    });

    consumer = consumerFromStringOrObject({
      identifier: "test",
      name: "Test ",
      group: " Testers ",
    });
    expect(consumer).toEqual({
      identifier: "test",
      name: "Test",
      group: "Testers",
    });
  });

  it("Add or update consumers", () => {
    const consumerRegistry = new ConsumerRegistry();
    consumerRegistry.addOrUpdateConsumer(null);
    consumerRegistry.addOrUpdateConsumer({ identifier: "test" });
    let data = consumerRegistry.getAndResetUpdatedConsumers();
    expect(data.length).toBe(0);

    const testConsumer = {
      identifier: "test",
      name: "Test",
      group: "Testers",
    };
    consumerRegistry.addOrUpdateConsumer(testConsumer);
    data = consumerRegistry.getAndResetUpdatedConsumers();
    expect(data.length).toBe(1);
    expect(data[0]).toEqual(testConsumer);

    consumerRegistry.addOrUpdateConsumer(testConsumer);
    data = consumerRegistry.getAndResetUpdatedConsumers();
    expect(data.length).toBe(0);

    consumerRegistry.addOrUpdateConsumer({
      identifier: "test",
      name: "Test 2",
      group: "Testers 2",
    });
    data = consumerRegistry.getAndResetUpdatedConsumers();
    expect(data.length).toBe(1);
  });
});
