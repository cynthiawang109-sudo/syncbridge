import { type Page, ProviderError } from "./provider";
export function validateSnapshotPage(
  page: Page,
  checkpoint: {
    snapshot: string | null;
    watermark: number | null;
    cursor: string | null;
    since: number;
  },
) {
  if (
    !page ||
    !Array.isArray(page.items) ||
    page.items.length > 100 ||
    !page.items.every(
      (row) =>
        row &&
        typeof row.id === "string" &&
        row.id.length > 0 &&
        typeof row.name === "string" &&
        Number.isInteger(row.version) &&
        row.version > 0 &&
        row.version <= 2147483647 &&
        (row.amount === undefined || Number.isFinite(row.amount)),
    ) ||
    new Set(page.items.map((row) => row.id)).size !== page.items.length ||
    typeof page.snapshot !== "string" ||
    !page.snapshot ||
    !Number.isInteger(page.watermark) ||
    page.watermark < checkpoint.since ||
    page.watermark > 2147483647 ||
    (page.cursor !== null &&
      (typeof page.cursor !== "string" ||
        !page.cursor ||
        page.cursor === checkpoint.cursor))
  ) {
    throw new ProviderError(502, "invalid_provider_page");
  }
  if (
    checkpoint.snapshot &&
    (page.snapshot !== checkpoint.snapshot ||
      page.watermark !== checkpoint.watermark)
  ) {
    throw new ProviderError(409, "snapshot_expired");
  }
}
