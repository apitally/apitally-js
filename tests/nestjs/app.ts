import { BadRequestException, Controller, Get, Module } from "@nestjs/common";
import { setConsumer } from "../../src/index.js";

class TestController {
  getItem(): { ok: true } {
    setConsumer({ identifier: "acme", name: "Acme Corp", group: "enterprise" });
    return { ok: true };
  }

  getBadRequest(): never {
    throw new BadRequestException("bad request");
  }

  getError(): never {
    throw new Error("boom");
  }
}

Controller()(TestController);
const descriptors = Object.getOwnPropertyDescriptors(TestController.prototype);
Get("items/:id")(TestController.prototype, "getItem", descriptors.getItem);
Get("bad-request")(TestController.prototype, "getBadRequest", descriptors.getBadRequest);
Get("error")(TestController.prototype, "getError", descriptors.getError);

export class AppModule {}

Module({ controllers: [TestController] })(AppModule);
