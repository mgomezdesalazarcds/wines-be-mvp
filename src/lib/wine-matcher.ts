import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import {
  normalizeWineName,
  normalizeSize,
  requiredMatchTokens,
  isGenericWineName,
} from "./wine-classifier";
import { disambiguateWineMatch, LabelDisambiguationInput } from "./ai";

export interface MatchResult {
  wine: SerializedWine;
  score: number;
  confidence: number;
}

/** Import-time dedup: does this (name, size) already exist as a generic
 * Wine, possibly imported by a different company? Two different companies'
 * CSVs have no shared identifier (no UPC/barcode — just each store's own
 * POS lookup_code), so this is the only signal available.
 *
 * Keyed on name + size together: a 750ml and a 1.5L of the same label are
 * different products, not the same wine at two sizes.
 *
 * Strategy: normalized-name exact match first (common case — POS
 * descriptions for the same product are often identical across stores),
 * then a stricter fuzzy fallback (high trigram similarity AND every
 * meaningful word of each name contained in the other) to avoid merging two
 * different wines that just share a producer or denomination.
 */
export async function findExistingWine(
  itemName: string,
  size: string | null
): Promise<{ id: string } | null> {
  const normalized = normalizeWineName(itemName);
  if (!normalized) return null;
  const normalizedSize = normalizeSize(size);

  const exact = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT id FROM wines
    WHERE upper(regexp_replace(item_name, '[^A-Za-z0-9 ]', ' ', 'g')) = ${normalized}
      AND size IS NOT DISTINCT FROM ${normalizedSize}
    LIMIT 1
  `);
  if (exact.length > 0) return exact[0];

  const FUZZY_THRESHOLD = 0.6;
  const candidates = await prisma.$queryRaw<{ id: string; item_name: string; sim: number }[]>(
    Prisma.sql`
      SELECT id, item_name, similarity(item_name, ${itemName}) AS sim
      FROM wines
      WHERE size IS NOT DISTINCT FROM ${normalizedSize}
        AND similarity(item_name, ${itemName}) >= ${FUZZY_THRESHOLD}
      ORDER BY sim DESC
      LIMIT 5
    `
  );

  const newTokens = requiredMatchTokens(itemName);
  for (const candidate of candidates) {
    const candidateTokens = requiredMatchTokens(candidate.item_name);
    const candidateNorm = normalizeWineName(candidate.item_name);
    const allNewTokensInCandidate = newTokens.every((t) => candidateNorm.includes(t));
    const allCandidateTokensInNew = candidateTokens.every((t) => normalized.includes(t));
    if (allNewTokensInCandidate && allCandidateTokensInNew) {
      return { id: candidate.id };
    }
  }

  return null;
}

/** The wire shape the frontend (wines-fe-react) already expects — unchanged
 * from wines-be-node, so no frontend changes are needed. `enrichment`
 * resolves company overrides over the generic default: `companyWine.extraData
 * ?? wine.extraData`. */
export interface SerializedWine {
  lookup_code: string;
  item_name: string;
  price: number;
  size: string | null;
  stock_count: number | null;
  availability: string | null;
  is_wine: boolean;
  section: string | null;
  staff_pick: boolean;
  image_url: string | null;
  created_at: Date;
}

interface CompanyWineRow {
  lookupCode: string;
  price: number;
  stockCount: number | null;
  availability: string | null;
  staffPick: boolean;
  imageUrl: string | null;
  createdAt: Date;
  extraData: unknown;
  wine: {
    itemName: string;
    size: string | null;
    isWine: boolean;
    section: string | null;
    extraData: unknown;
  };
}

function serializeCompanyWine(cw: CompanyWineRow): SerializedWine {
  return {
    lookup_code: cw.lookupCode,
    item_name: cw.wine.itemName,
    price: cw.price,
    size: cw.wine.size,
    stock_count: cw.stockCount,
    availability: cw.availability,
    is_wine: cw.wine.isWine,
    section: cw.wine.section,
    staff_pick: cw.staffPick,
    image_url: cw.imageUrl,
    created_at: cw.createdAt,
  };
}

function resolveEnrichment(cw: Pick<CompanyWineRow, "extraData" | "wine">) {
  return cw.extraData ?? cw.wine.extraData;
}

const WINE_SELECT = {
  itemName: true,
  size: true,
  isWine: true,
  section: true,
  extraData: true,
} as const;

export async function getStaffPicks(companyId: string, sections?: string[]) {
  const rows = await prisma.companyWine.findMany({
    where: {
      companyId,
      staffPick: true,
      wine: { isWine: true, ...(sections?.length ? { section: { in: sections } } : {}) },
    },
    include: { wine: { select: WINE_SELECT } },
    orderBy: { wine: { itemName: "asc" } },
  });
  return rows.map(serializeCompanyWine);
}

export async function listWines(companyId: string, sections?: string[], limit = 50) {
  const rows = await prisma.companyWine.findMany({
    where: {
      companyId,
      wine: { isWine: true, ...(sections?.length ? { section: { in: sections } } : {}) },
    },
    include: { wine: { select: WINE_SELECT } },
    orderBy: { wine: { itemName: "asc" } },
    take: limit,
  });
  return rows.map(serializeCompanyWine);
}

/** Trigram-similarity search against Postgres (`pg_trgm`), scoped to one
 * company's listings. Takes several query variants at once and scores each
 * row against all of them in a single round-trip (`GREATEST(...)`) — see
 * buildCandidatePool below for why. */
async function fuzzySearchCompanyWines(
  companyId: string,
  queries: string[],
  sections?: string[],
  limit = 15
): Promise<(SerializedWine & { matchConfidence: number })[]> {
  const sectionFilter =
    sections && sections.length
      ? Prisma.sql`AND w.section IN (${Prisma.join(sections)})`
      : Prisma.empty;

  const simExpr = Prisma.join(
    queries.map((q) => Prisma.sql`word_similarity(${q}, w.item_name)`),
    ", "
  );

  const rows = await prisma.$queryRaw<
    {
      lookup_code: string;
      item_name: string;
      price: number;
      size: string | null;
      stock_count: number | null;
      availability: string | null;
      is_wine: boolean;
      section: string | null;
      staff_pick: boolean;
      image_url: string | null;
      created_at: Date;
      sim: number;
    }[]
  >`
    SELECT lookup_code, item_name, price, size, stock_count, availability,
      is_wine, section, staff_pick, image_url, created_at, sim
    FROM (
      SELECT cw.lookup_code, w.item_name, cw.price, w.size, cw.stock_count, cw.availability,
        w.is_wine, w.section, cw.staff_pick, cw.image_url, cw.created_at,
        GREATEST(${simExpr}) AS sim
      FROM company_wines cw
      JOIN wines w ON w.id = cw.wine_id
      WHERE cw.company_id = ${companyId}
        AND w.is_wine = true
        ${sectionFilter}
    ) scored
    WHERE sim >= 0.3
    ORDER BY sim DESC
    LIMIT ${limit}
  `;

  return rows.map((r) => ({
    lookup_code: r.lookup_code,
    item_name: r.item_name,
    price: r.price,
    size: r.size,
    stock_count: r.stock_count,
    availability: r.availability,
    is_wine: r.is_wine,
    section: r.section,
    staff_pick: r.staff_pick,
    image_url: r.image_url,
    created_at: r.created_at,
    matchConfidence: r.sim,
  }));
}

export async function searchWines(
  companyId: string,
  query: string,
  sections?: string[],
  limit = 15
): Promise<(SerializedWine & { matchConfidence: number })[]> {
  return fuzzySearchCompanyWines(companyId, [query], sections, limit);
}

export async function getWineDetail(companyId: string, lookupCode: string) {
  const cw = await prisma.companyWine.findUnique({
    where: { companyId_lookupCode: { companyId, lookupCode } },
    include: { wine: { select: WINE_SELECT } },
  });
  if (!cw) return null;

  return { wine: serializeCompanyWine(cw), enrichment: resolveEnrichment(cw) };
}

const STRONG_MATCH_CONFIDENCE = 0.5;
const CANDIDATE_POOL_SIZE = 20;

interface RequiredTokenCandidate {
  lookupCode: string;
  itemName: string;
  confidence: number;
}

/** True when the top-scored candidate is the ONE wine (not just the
 * top-scored one) that contains every required word from the label — lets
 * `resolveSingleMatch` skip the AI disambiguation call. */
function hasStrongUnambiguousMatch(
  extracted: LabelDisambiguationInput,
  candidates: RequiredTokenCandidate[]
): boolean {
  if (candidates.length === 0 || candidates[0].confidence < STRONG_MATCH_CONFIDENCE) {
    return false;
  }

  const requiredTokens = [
    ...(extracted.producer ? requiredMatchTokens(extracted.producer) : []),
    ...(extracted.wineName ? requiredMatchTokens(extracted.wineName) : []),
  ];
  if (requiredTokens.length === 0) return false;

  const satisfying = candidates.filter((c) => {
    const nameUpper = c.itemName.toUpperCase();
    return requiredTokens.every((t) => nameUpper.includes(t));
  });
  const satisfyingNames = new Set(satisfying.map((c) => normalizeWineName(c.itemName)));

  return (
    satisfyingNames.size === 1 && satisfying.some((c) => c.lookupCode === candidates[0].lookupCode)
  );
}

/** Runs every available signal (producer+name, producer alone, name alone,
 * full label text) as separate fuzzy queries and pools the results into one
 * deduplicated candidate list, scoped to this company's catalog and the
 * given sections (never the whole catalog — see wines-be-node for the
 * performance story behind that). */
async function buildCandidatePool(
  companyId: string,
  extracted: LabelDisambiguationInput,
  limit: number,
  sections?: string[]
): Promise<MatchResult[]> {
  const wineNameAloneIsUseful =
    !extracted.producer || !isGenericWineName(extracted.wineName ?? "");

  const queries = [
    extracted.producer && extracted.wineName
      ? `${extracted.producer} ${extracted.wineName}`
      : null,
    extracted.producer,
    wineNameAloneIsUseful ? extracted.wineName : null,
    extracted.fullText ? normalizeWineName(extracted.fullText) : null,
  ].filter((q): q is string => !!q && q.length > 2);

  if (queries.length === 0) return [];

  const pooled = await fuzzySearchCompanyWines(companyId, queries, sections, limit);
  return pooled.map((w) => ({ wine: w, score: 1 - w.matchConfidence, confidence: w.matchConfidence }));
}

async function resolveSingleMatch(
  extracted: LabelDisambiguationInput,
  candidates: MatchResult[]
): Promise<MatchResult | null> {
  if (
    hasStrongUnambiguousMatch(
      extracted,
      candidates.map((c) => ({
        lookupCode: c.wine.lookup_code,
        itemName: c.wine.item_name,
        confidence: c.confidence,
      }))
    )
  ) {
    return candidates[0];
  }

  const picked = await disambiguateWineMatch(
    extracted,
    candidates.map((c) => ({ lookupCode: c.wine.lookup_code, itemName: c.wine.item_name }))
  );
  if (!picked) return null;

  const matched = candidates.find((c) => c.wine.lookup_code === picked.lookupCode);
  if (!matched) return null;

  return { wine: matched.wine, score: 1 - picked.confidence, confidence: picked.confidence };
}

/** Two-step match: (1) build a small candidate pool cheaply via fuzzy search,
 * then (2) only call the AI to disambiguate when the fuzzy signal alone
 * isn't trustworthy. Returns an array, not a single result: a label photo
 * usually can't tell bottle size apart, so when the resolved match has
 * "siblings" in the pool — same name, different size — all of them come
 * back instead of silently guessing one. Empty array = no match. */
export async function matchFromLabelText(
  companyId: string,
  extracted: LabelDisambiguationInput,
  sections?: string[]
): Promise<MatchResult[]> {
  const candidates = await buildCandidatePool(companyId, extracted, CANDIDATE_POOL_SIZE, sections);
  if (candidates.length === 0) return [];

  const matched = await resolveSingleMatch(extracted, candidates);
  if (!matched) return [];

  const matchedNameKey = normalizeWineName(matched.wine.item_name);
  const siblings = candidates.filter(
    (c) =>
      c.wine.lookup_code !== matched.wine.lookup_code &&
      c.wine.size !== matched.wine.size &&
      normalizeWineName(c.wine.item_name) === matchedNameKey
  );

  return [matched, ...siblings];
}
