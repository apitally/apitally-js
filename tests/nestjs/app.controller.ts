import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Query,
  ValidationPipe,
} from "@nestjs/common";
import { IsInt, IsNotEmpty, Min, MinLength } from "class-validator";

export class HelloQueryDTO {
  @IsNotEmpty()
  @MinLength(2)
  name?: string;

  @IsInt()
  @Min(18)
  age?: number;
}

@Controller()
export class AppController {
  @Get("/hello")
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
  getHelloById(@Param("id", new ParseIntPipe()) id: number) {
    return `Hello ID ${id}!`;
  }

  @Get("/error")
  getError() {
    throw new Error("Error");
  }
}
