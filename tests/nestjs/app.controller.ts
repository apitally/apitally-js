import {
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  Header,
  Injectable,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
  ValidationPipe,
} from "@nestjs/common";
import { IsInt, IsNotEmpty, Min, MinLength } from "class-validator";

@Injectable()
export class AuthGuard implements CanActivate {
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest();
    request.apitallyConsumer = "test";
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
  @Get("/hello")
  @Header("Content-Type", "text/plain")
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

  @Post("/hello")
  @Header("Content-Type", "text/plain")
  postHello(
    @Body(
      new ValidationPipe({
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    )
    { name, age }: HelloBodyDTO,
  ) {
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
}
