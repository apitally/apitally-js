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

import {
  ApitallyApiKeyGuard,
  GetKeyInfo,
  KeyInfo,
  Scopes,
} from "../../src/nestjs/index.js";

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
    @GetKeyInfo() keyInfo: KeyInfo,
  ) {
    return `Hello ${name}! You are ${age} years old! You are authenticated as ${keyInfo.name}!`;
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
