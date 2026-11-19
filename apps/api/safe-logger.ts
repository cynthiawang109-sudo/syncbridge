import type { LoggerService } from "@nestjs/common";
import { telemetry } from "../../packages/shared/telemetry";

// Framework exceptions may include SQL inputs or request bodies. Emit severity only.
export const safeFrameworkLogger: LoggerService = {
  log() {},
  error() {
    telemetry("api_framework_error", {}, "error");
  },
  warn() {
    telemetry("api_framework_warning", {}, "warn");
  },
};
