import {
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  Header,
  Injectable,
  Logger,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { trace } from "@opentelemetry/api";
import { IsInt, IsNotEmpty, Min, MinLength } from "class-validator";
import { setConsumer } from "../../src/nestjs/index.js";

@Injectable()
export class AuthGuard implements CanActivate {
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest();
    setConsumer(request, "test");
    return true;
  }
}

export class HelloQueryDTO {
  @IsNotEmpty()
  @MinLength(2)
  name?: string;

  @IsInt()
  @Min(18)
  age?: number;
}

export class HelloBodyDTO {
  @IsNotEmpty()
  @MinLength(2)
  name?: string;

  @IsInt()
  @Min(18)
  age?: number;
}

@Controller()
@UseGuards(AuthGuard)
export class AppController {
  private readonly logger = new Logger(AppController.name);

  @Get("/hello")
  @Header("Content-Type", "text/plain")
  getHello(@Query() { name, age }: HelloQueryDTO) {
    this.logger.log("Logger test");
    return `Hello ${name}! You are ${age} years old!`;
  }

  @Post("/hello")
  @Header("Content-Type", "text/plain")
  postHello(@Body() { name, age }: HelloBodyDTO) {
    return `Hello ${name}! You are ${age} years old!`;
  }

  @Get("/hello/:id")
  @Header("Content-Type", "text/plain")
  getHelloById(@Param("id", new ParseIntPipe()) id: number) {
    return `Hello ID ${id}!`;
  }

  @Get("/error")
  getError() {
    throw new Error("test");
  }

  @Get("/traces")
  async getTraces() {
    const tracer = trace.getTracer("test");
    await tracer.startActiveSpan("outer_span", async (outerSpan) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      await tracer.startActiveSpan("inner_span_1", async (innerSpan1) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        innerSpan1.end();
      });
      await tracer.startActiveSpan("inner_span_2", async (innerSpan2) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        innerSpan2.end();
      });
      outerSpan.end();
    });
    return "traces";
  }
}
