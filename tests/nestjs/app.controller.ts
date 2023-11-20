import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Query,
  UseGuards,
  ValidationPipe,
} from "@nestjs/common";
import { IsInt, IsNotEmpty, Min, MinLength } from "class-validator";

import { ApitallyApiKeyGuard, Scopes } from "../../src/nestjs";

export class HelloQueryDTO {
  @IsNotEmpty()
  @MinLength(2)
  name?: string;

  @IsInt()
  @Min(18)
  age?: number;
}

@Controller()
@UseGuards(ApitallyApiKeyGuard)
export class AppController {
  @Get("/hello")
  @Scopes("hello1")
  getHello(
    @Query(
      new ValidationPipe({
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    )
    { name, age }: HelloQueryDTO,
  ) {
    return `Hello ${name}! You are ${age} years old!`;
  }

  @Get("/hello/:id")
  @Scopes("hello2")
  getHelloById(@Param("id", new ParseIntPipe()) id: number) {
    return `Hello ID ${id}!`;
  }

  @Get("/error")
  getError() {
    throw new Error("Error");
  }
}
