-- AlterTable
ALTER TABLE "connections" ADD COLUMN     "reconcile_employees_at" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP + interval '1 hour'),
ADD COLUMN     "reconcile_payruns_at" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP + interval '1 hour');

-- AlterTable
ALTER TABLE "operation_attempt" ADD COLUMN     "reconciliation_id" TEXT,
ADD COLUMN     "repair_record_id" TEXT;

-- CreateTable
CREATE TABLE "reconciliation_runs" (
    "id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'traversing',
    "reason" TEXT,
    "page" INTEGER NOT NULL DEFAULT 0,
    "cursor" TEXT,
    "snapshot" TEXT,
    "watermark" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "reconciliation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliation_findings" (
    "run_id" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "classification" TEXT NOT NULL,
    "confidence" TEXT NOT NULL,
    "mirror_version" INTEGER,
    "provider_version" INTEGER,
    "repair_status" TEXT NOT NULL DEFAULT 'none',
    "repair_result" TEXT,

    CONSTRAINT "reconciliation_findings_pkey" PRIMARY KEY ("run_id","external_id")
);

-- CreateTable
CREATE TABLE "reconciliation_observations" (
    "run_id" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "hash" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,

    CONSTRAINT "reconciliation_observations_pkey" PRIMARY KEY ("run_id","external_id")
);

-- CreateIndex
CREATE INDEX "reconciliation_runs_connection_id_resource_type_created_at_idx" ON "reconciliation_runs"("connection_id", "resource_type", "created_at");

-- AddForeignKey
ALTER TABLE "operation_attempt" ADD CONSTRAINT "operation_attempt_reconciliation_id_fkey" FOREIGN KEY ("reconciliation_id") REFERENCES "reconciliation_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_runs" ADD CONSTRAINT "reconciliation_runs_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_findings" ADD CONSTRAINT "reconciliation_findings_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "reconciliation_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_observations" ADD CONSTRAINT "reconciliation_observations_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "reconciliation_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX reconciliation_one_traversal ON reconciliation_runs (connection_id, resource_type) WHERE status = 'traversing';
