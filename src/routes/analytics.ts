import { Router, Request, Response } from "express";
import { prisma, getDefaultCompanyId } from "../lib/db";
import { asyncHandler } from "../lib/asyncHandler";

const router = Router();

// Pilot scope: public, no login — see AnalyticsEvent in schema.prisma for why.
const EVENT_TYPES = [
  "qr_visit",
  "wine_viewed",
  "staff_favorites_view",
  "new_arrivals_view",
  "wine_saved",
] as const;
type EventType = (typeof EVENT_TYPES)[number];

router.post(
  "/events",
  asyncHandler(async (req: Request, res: Response) => {
    const companyId = await getDefaultCompanyId();
    const { type, metadata } = req.body ?? {};

    if (typeof type !== "string" || !EVENT_TYPES.includes(type as EventType)) {
      return res.status(400).json({ error: `type must be one of: ${EVENT_TYPES.join(", ")}` });
    }
    if (metadata !== undefined && (typeof metadata !== "object" || metadata === null || Array.isArray(metadata))) {
      return res.status(400).json({ error: "metadata must be an object" });
    }

    await prisma.analyticsEvent.create({ data: { companyId, type, metadata } });
    return res.status(201).json({ ok: true });
  })
);

router.get(
  "/summary",
  asyncHandler(async (_req: Request, res: Response) => {
    const companyId = await getDefaultCompanyId();

    const [eventCounts, scanLogCounts, scanFailureLogCount] = await Promise.all([
      prisma.analyticsEvent.groupBy({
        by: ["type"],
        where: { companyId },
        _count: { _all: true },
      }),
      prisma.scanLog.groupBy({
        by: ["status"],
        where: { companyId },
        _count: { _all: true },
      }),
      prisma.failureLog.count({ where: { companyId, source: "scan" } }),
    ]);

    const eventCountByType = Object.fromEntries(
      eventCounts.map((row) => [row.type, row._count._all])
    ) as Record<EventType, number | undefined>;
    const scanCountByStatus = Object.fromEntries(
      scanLogCounts.map((row) => [row.status, row._count._all])
    );

    const scanSuccess =
      (scanCountByStatus.matched ?? 0) + (scanCountByStatus.multiple_matches ?? 0);
    const scanFailure = (scanCountByStatus.not_identified ?? 0) + scanFailureLogCount;

    return res.json({
      qrVisits: eventCountByType.qr_visit ?? 0,
      scanSuccess,
      scanFailure,
      winesViewed: eventCountByType.wine_viewed ?? 0,
      staffFavoritesViews: eventCountByType.staff_favorites_view ?? 0,
      newArrivalsViews: eventCountByType.new_arrivals_view ?? 0,
      winesSaved: eventCountByType.wine_saved ?? 0,
    });
  })
);

interface DetailRow {
  date: string;
  wineName: string | null;
  lookupCode: string | null;
  extra: string | null;
}

async function resolveWineNames(
  companyId: string,
  lookupCodes: string[]
): Promise<Map<string, string>> {
  const codes = [...new Set(lookupCodes)];
  if (codes.length === 0) return new Map();
  const rows = await prisma.companyWine.findMany({
    where: { companyId, lookupCode: { in: codes } },
    select: { lookupCode: true, wine: { select: { itemName: true } } },
  });
  return new Map(rows.map((r) => [r.lookupCode, r.wine.itemName]));
}

const SCAN_STATUS_LABEL: Record<string, string> = {
  matched: "Matched",
  multiple_matches: "Multiple matches",
  not_identified: "Not identified",
};

const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 100;

router.get(
  "/events/:key",
  asyncHandler(async (req: Request, res: Response) => {
    const companyId = await getDefaultCompanyId();
    const key = String(req.params.key);
    const page = Math.max(0, parseInt(String(req.query.page ?? "0"), 10) || 0);
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, parseInt(String(req.query.pageSize ?? String(DEFAULT_PAGE_SIZE)), 10) || DEFAULT_PAGE_SIZE)
    );

    if (key === "scanSuccess" || key === "scanFailure") {
      const statuses = key === "scanSuccess" ? ["matched", "multiple_matches"] : ["not_identified"];
      const where = { companyId, status: { in: statuses } };
      const [total, logs] = await Promise.all([
        prisma.scanLog.count({ where }),
        prisma.scanLog.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip: page * pageSize,
          take: pageSize,
        }),
      ]);
      const nameByCode = await resolveWineNames(
        companyId,
        logs.map((l) => l.matchedLookupCode).filter((c): c is string => !!c)
      );
      const rows: DetailRow[] = logs.map((log) => ({
        date: log.createdAt.toISOString(),
        wineName: log.matchedLookupCode ? nameByCode.get(log.matchedLookupCode) ?? null : null,
        lookupCode: log.matchedLookupCode,
        // `confidence` means different things depending on status: for a
        // match, it's how confident the match against inventory was; for
        // not_identified, no match was made at all, so it's actually how
        // clearly the AI could read the label off the photo. Same column,
        // different meaning — label it accordingly so the two don't read as
        // contradictory (e.g. "Not identified" next to a high number).
        extra: log.confidence == null
          ? SCAN_STATUS_LABEL[log.status] ?? log.status
          : log.status === "not_identified"
            ? `${SCAN_STATUS_LABEL[log.status]} · label read at ${Math.round(log.confidence * 100)}% confidence`
            : `${SCAN_STATUS_LABEL[log.status] ?? log.status} · ${Math.round(log.confidence * 100)}% match confidence`,
      }));
      return res.json({ rows, total, page, pageSize });
    }

    const EVENT_TYPE_BY_KEY: Record<string, EventType> = {
      qrVisits: "qr_visit",
      winesViewed: "wine_viewed",
      staffFavoritesViews: "staff_favorites_view",
      newArrivalsViews: "new_arrivals_view",
      winesSaved: "wine_saved",
    };
    const type = EVENT_TYPE_BY_KEY[key];
    if (!type) {
      return res.status(404).json({ error: "Unknown analytics key" });
    }

    const where = { companyId, type };
    const [total, events] = await Promise.all([
      prisma.analyticsEvent.count({ where }),
      prisma.analyticsEvent.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: page * pageSize,
        take: pageSize,
      }),
    ]);
    const lookupCodes = events
      .map((e) => (e.metadata as { lookupCode?: string } | null)?.lookupCode)
      .filter((c): c is string => !!c);
    const nameByCode = await resolveWineNames(companyId, lookupCodes);
    const rows: DetailRow[] = events.map((e) => {
      const lookupCode = (e.metadata as { lookupCode?: string } | null)?.lookupCode ?? null;
      return {
        date: e.createdAt.toISOString(),
        wineName: lookupCode ? nameByCode.get(lookupCode) ?? null : null,
        lookupCode,
        extra: null,
      };
    });
    return res.json({ rows, total, page, pageSize });
  })
);

export default router;
