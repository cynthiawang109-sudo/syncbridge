import "reflect-metadata";
import { Controller, Get, Module } from "@nestjs/common";
import { APP_GUARD, NestFactory } from "@nestjs/core";
import { AuthGuard, Public } from "./auth";
import { TenantsController } from "./tenants";
import { OAuthController } from "./oauth";
import { SyncController } from "./sync";
@Controller()
class HealthController {
  @Public()
  @Get("health")
  health() {
    return { ok: true };
  }
}
@Module({
  controllers: [
    HealthController,
    TenantsController,
    OAuthController,
    SyncController,
  ],
  providers: [{ provide: APP_GUARD, useClass: AuthGuard }],
})
class AppModule {}
void NestFactory.create(AppModule).then((app) => app.listen(3000, "0.0.0.0"));
