import "reflect-metadata";
import { Module } from "@nestjs/common";
import { APP_GUARD, NestFactory } from "@nestjs/core";
import { AuthGuard } from "./auth";
@Module({ providers: [{ provide: APP_GUARD, useClass: AuthGuard }] })
class AppModule {}
void NestFactory.create(AppModule).then((app) => app.listen(3000, "0.0.0.0"));
