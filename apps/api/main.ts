import "reflect-metadata";
import { raw } from "express";
import { initArchive } from "../../packages/shared/archive";
import { webhookLimit } from "../../packages/shared/events";
import { WebhooksController } from "./webhooks";
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
    WebhooksController,
  ],
  providers: [{ provide: APP_GUARD, useClass: AuthGuard }],
})
class AppModule {}
async function bootstrap() {
  for (let attempt = 0; ; attempt++) {
    try {
      await initArchive();
      break;
    } catch (error) {
      if (attempt >= 20) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  const app = await NestFactory.create(AppModule);
  app.use(
    "/webhooks",
    raw({ type: "application/json", limit: webhookLimit, inflate: false }),
  );
  await app.listen(3000, "0.0.0.0");
}
void bootstrap();
