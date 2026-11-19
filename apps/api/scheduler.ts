import {
  Controller,
  Headers,
  HttpCode,
  NotFoundException,
  Post,
  UnauthorizedException,
} from "@nestjs/common";
import { createHash, timingSafeEqual } from "node:crypto";
import { Public } from "./auth";
import { scheduleReconciliation } from "../../packages/shared/reconciliation";

@Controller("internal/reconciliation")
export class SchedulerController {
  @Public()
  @Post("enqueue")
  @HttpCode(202)
  async enqueue(@Headers("x-scheduler-key") provided?: string) {
    const expected = process.env.SCHEDULER_SECRET;
    if (!expected) throw new NotFoundException();
    const hash = (value: string) => createHash("sha256").update(value).digest();
    if (
      typeof provided !== "string" ||
      !timingSafeEqual(hash(expected), hash(provided))
    ) {
      throw new UnauthorizedException();
    }
    await scheduleReconciliation();
    return { accepted: true };
  }
}
