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

export default router;
