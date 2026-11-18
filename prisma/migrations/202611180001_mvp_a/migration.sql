-- CreateEnum
CREATE TYPE "Lifecycle" AS ENUM ('active', 'closing', 'deleted');

-- CreateEnum
CREATE TYPE "TokenStatus" AS ENUM ('disconnected', 'connected', 'needs_reauth', 'error');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('queued', 'running', 'succeeded', 'partial', 'failed');

-- CreateEnum
CREATE TYPE "Mode" AS ENUM ('full', 'incremental');

-- CreateEnum
CREATE TYPE "ClaimState" AS ENUM ('pending', 'claimed', 'done', 'failed');

-- CreateTable
CREATE TABLE "tenants" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connections" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'mock',
    "lifecycle" "Lifecycle" NOT NULL DEFAULT 'active',
    "generation" INTEGER NOT NULL DEFAULT 0,
    "token_status" "TokenStatus" NOT NULL DEFAULT 'disconnected',
    "token_error" TEXT,
    "encrypted_tokens" TEXT,
    "key_version" TEXT,
    "token_expires_at" TIMESTAMP(3),
    "token_version" INTEGER NOT NULL DEFAULT 0,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "refresh_generation" INTEGER NOT NULL DEFAULT 0,
    "refresh_lease_until" TIMESTAMP(3),
    "oauth_state_hash" TEXT,
    "oauth_verifier" TEXT,
    "oauth_expires_at" TIMESTAMP(3),
    "watermark" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "external_records" (
    "connection_id" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "tombstone" BOOLEAN NOT NULL DEFAULT false,
    "last_synced_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "external_records_pkey" PRIMARY KEY ("connection_id","resource_type","external_id")
);

-- CreateTable
CREATE TABLE "sync_runs" (
    "id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "resource_type" TEXT NOT NULL DEFAULT 'employees',
    "mode" "Mode" NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'queued',
    "cursor" TEXT,
    "snapshot" TEXT,
    "watermark" INTEGER,
    "since" INTEGER NOT NULL,
    "page" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_record_outcomes" (
    "run_id" TEXT NOT NULL,
    "record_key" TEXT NOT NULL,
    "operation_identity" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "result" TEXT NOT NULL,
    "conflict_hash" TEXT,

    CONSTRAINT "sync_record_outcomes_pkey" PRIMARY KEY ("run_id","record_key","operation_identity")
);

-- CreateTable
CREATE TABLE "operation_attempt" (
    "key" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "due_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "state" "ClaimState" NOT NULL DEFAULT 'pending',
    "claim_token" TEXT,
    "lease_until" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "operation_attempt_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "authorization_audit" (
    "id" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "object" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "authorization_audit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "connections_oauth_state_hash_key" ON "connections"("oauth_state_hash");

-- CreateIndex
CREATE INDEX "connections_tenant_id_idx" ON "connections"("tenant_id");

-- CreateIndex
CREATE INDEX "operation_attempt_state_due_at_idx" ON "operation_attempt"("state", "due_at");

-- AddForeignKey
ALTER TABLE "connections" ADD CONSTRAINT "connections_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_records" ADD CONSTRAINT "external_records_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_record_outcomes" ADD CONSTRAINT "sync_record_outcomes_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "sync_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_record_outcomes" ADD CONSTRAINT "sync_record_outcomes_connection_id_resource_type_record_ke_fkey" FOREIGN KEY ("connection_id", "resource_type", "record_key") REFERENCES "external_records"("connection_id", "resource_type", "external_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operation_attempt" ADD CONSTRAINT "operation_attempt_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "sync_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


CREATE UNIQUE INDEX "sync_runs_one_active" ON "sync_runs" ("connection_id", "resource_type") WHERE "status" IN ('queued', 'running');
