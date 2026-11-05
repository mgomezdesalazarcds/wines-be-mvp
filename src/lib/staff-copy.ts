/**
 * Per-store staff copy from inventory CSV → CompanyWine.extraData.
 * AI enrichment must never overwrite these keys (see STAFF_EXTRA_DATA_KEYS).
 */

export const STAFF_NAME_FALLBACK = "noname";

export interface StaffCopyPatch {
  staff_note: string;
  staff_name: string;
}

/**
 * Apply optional CSV staff_note / staff_name onto existing company extraData.
 *
 * Rules:
 * - No staff_note column in the file → null (caller must not write).
 * - staff_note empty → null (do not touch stored staff fields).
 * - Note + name both present → overwrite both.
 * - Note present, name empty → keep existing staff_name, else "noname".
 */
export function staffCopyFromCsvRow(input: {
  hasStaffNoteColumn: boolean;
  hasStaffNameColumn: boolean;
  csvNote: string | undefined | null;
  csvName: string | undefined | null;
  existingExtraData: unknown;
}): StaffCopyPatch | null {
  if (!input.hasStaffNoteColumn) return null;

  const note = String(input.csvNote ?? "").replace(/[\t\r\n]+/g, " ").trim();
  if (!note) return null;

  const existing =
    input.existingExtraData && typeof input.existingExtraData === "object"
      ? (input.existingExtraData as Record<string, unknown>)
      : {};
  const existingName = String(existing.staff_name ?? "").trim();

  const csvName = input.hasStaffNameColumn
    ? String(input.csvName ?? "").replace(/[\t\r\n]+/g, " ").trim()
    : "";

  const staff_name = csvName
    ? csvName
    : existingName
      ? existingName
      : STAFF_NAME_FALLBACK;

  return { staff_note: note, staff_name };
}

export function mergeStaffCopyIntoExtraData(
  existingExtraData: unknown,
  patch: StaffCopyPatch
): Record<string, unknown> {
  const existing =
    existingExtraData && typeof existingExtraData === "object"
      ? (existingExtraData as Record<string, unknown>)
      : {};
  return {
    ...existing,
    staff_note: patch.staff_note,
    staff_name: patch.staff_name,
  };
}
