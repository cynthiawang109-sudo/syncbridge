-- CreateEnum
CREATE TYPE "ReplayState" AS ENUM ('open', 'replay_queued', 'resolved', 'reopened');

-- DropForeignKey
ALTER TABLE "operation_attempt" DROP CONSTRAINT "operation_attempt_run_id_fkey";

-- AlterTable
ALTER TABLE "connections" ADD COLUMN     "cleanup_at" TIMESTAMP(3),
ADD COLUMN     "failure_streak" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "paused_reason" TEXT,
ADD COLUMN     "payrun_watermark" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "rate_streak" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "rate_until" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "operation_attempt" ADD COLUMN     "connection_id" TEXT,
ADD COLUMN     "dead_letter_id" TEXT,
ADD COLUMN     "event_id" TEXT,
ADD COLUMN     "evidence" JSONB,
ADD COLUMN     "generation" INTEGER,
ADD COLUMN     "projection_pending" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "replay_id" TEXT,
ALTER COLUMN "run_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "dead_letters" (
    "id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "operation_key" TEXT NOT NULL,
    "event_id" TEXT,
    "run_id" TEXT,
    "reason" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "provider_error" JSONB,
    "state" "ReplayState" NOT NULL DEFAULT 'open',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dead_letters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attempt_history" (
    "operation_key" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "result" TEXT NOT NULL,
    "provider_error" JSONB,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attempt_history_pkey" PRIMARY KEY ("operation_key","attempt")
);

-- CreateTable
CREATE TABLE "replay_audit" (
    "id" TEXT NOT NULL,
    "dead_letter_id" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "archive_absent" BOOLEAN,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "replay_audit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_outcomes" (
    "operation_key" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "event_version" INTEGER NOT NULL,
    "fetched_version" INTEGER,
    "result" TEXT NOT NULL,
    "conflict_hash" TEXT,

    CONSTRAINT "webhook_outcomes_pkey" PRIMARY KEY ("operation_key")
);

-- CreateIndex
CREATE INDEX "dead_letters_tenant_id_connection_id_idx" ON "dead_letters"("tenant_id", "connection_id");

-- CreateIndex
CREATE UNIQUE INDEX "dead_letters_connection_id_operation_key_key" ON "dead_letters"("connection_id", "operation_key");

-- CreateIndex
CREATE INDEX "replay_audit_dead_letter_id_idx" ON "replay_audit"("dead_letter_id");

-- CreateIndex
CREATE INDEX "webhook_outcomes_connection_id_event_id_idx" ON "webhook_outcomes"("connection_id", "event_id");

-- CreateIndex
CREATE UNIQUE INDEX "operation_attempt_replay_id_key" ON "operation_attempt"("replay_id");

-- CreateIndex
CREATE INDEX "operation_attempt_connection_id_state_idx" ON "operation_attempt"("connection_id", "state");

-- AddForeignKey
ALTER TABLE "operation_attempt" ADD CONSTRAINT "operation_attempt_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "sync_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "replay_audit" ADD CONSTRAINT "replay_audit_dead_letter_id_fkey" FOREIGN KEY ("dead_letter_id") REFERENCES "dead_letters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

UPDATE operation_attempt AS a SET connection_id = r.connection_id, generation = r.generation FROM sync_runs AS r WHERE a.run_id = r.id;
