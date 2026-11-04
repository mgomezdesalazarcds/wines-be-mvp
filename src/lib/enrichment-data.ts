/** Shape stored in `Wine.extraData` (and optionally overridden on
 * `CompanyWine.extraData`). Matches what wines-fe-react reads for Taste
 * Profile / Flavor Circles + How It Drinks scales. */

export const FLAVOR_FAMILIES = [
  "red_fruit",
  "black_fruit",
  "citrus",
  "stone_tropical",
  "floral",
  "herbal",
  "spice",
  "earth_mineral",
] as const;

export type FlavorFamily = (typeof FLAVOR_FAMILIES)[number];

/** Documented fallback when the model returns an unknown family. */
export const DEFAULT_FLAVOR_FAMILY: FlavorFamily = "earth_mineral";

export type FlavorIntensity = 1 | 2 | 3;
export type WineType = "red" | "white" | "rose";

export interface FlavorCircle {
  name: string;
  intensity: FlavorIntensity;
  family: FlavorFamily;
}

export interface EnrichmentData {
  tasting_notes: string;
  /** One-line Taste Profile summary shown above the circles. */
  taste_summary: string;
  /** Structured circles for the FE. Prefer this over `taste_profile`. */
  flavors: FlavorCircle[];
  /** Legacy string list kept in sync with `flavors[].name` for older clients. */
  taste_profile: string[];
  pairs_well_with: string[];
  variety: string | null;
  region: string | null;
  country: string | null;
  wine_type: WineType;
  body: number;
  acidity: number;
  tannin: number;
  sweetness: number;
  fruity_earthy: number;
  crisp_creamy: number;
  dryness_label: string;
  provenance: "verified" | "inferred";
}

/** Staff-authored keys that live on company (or rarely wine) extraData.
 * AI enrichment must never overwrite these. */
export const STAFF_EXTRA_DATA_KEYS = [
  "staff_note",
  "staff_name",
  "why_we_love_it",
  "from_the_team",
] as const;

const FAMILY_SET = new Set<string>(FLAVOR_FAMILIES);

const FAMILY_ALIASES: Record<string, FlavorFamily> = {
  red_fruit: "red_fruit",
  red_fruits: "red_fruit",
  redfruit: "red_fruit",
  berry: "red_fruit",
  berries: "red_fruit",
  black_fruit: "black_fruit",
  black_fruits: "black_fruit",
  blackfruit: "black_fruit",
  citrus: "citrus",
  citricos: "citrus",
  stone_tropical: "stone_tropical",
  stonetropical: "stone_tropical",
  tropical: "stone_tropical",
  stone: "stone_tropical",
  stone_fruit: "stone_tropical",
  floral: "floral",
  flower: "floral",
  herbal: "herbal",
  herb: "herbal",
  herbs: "herbal",
  spice: "spice",
  spices: "spice",
  earth_mineral: "earth_mineral",
  earthmineral: "earth_mineral",
  earth: "earth_mineral",
  mineral: "earth_mineral",
  earth_minerals: "earth_mineral",
};

const DEFAULT_FLAVORS: FlavorCircle[] = [
  { name: "Cherry", intensity: 3, family: "red_fruit" },
  { name: "Herb", intensity: 2, family: "herbal" },
  { name: "Earth", intensity: 1, family: "earth_mineral" },
];

function clampScale(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(5, Math.max(1, Math.round(n)));
}

function normalizeFamily(raw: unknown): FlavorFamily {
  const key = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s\/-]+/g, "_");
  if (FAMILY_SET.has(key)) return key as FlavorFamily;
  return FAMILY_ALIASES[key] ?? DEFAULT_FLAVOR_FAMILY;
}

function normalizeWineType(raw: unknown, itemHint?: string): WineType {
  const folded = String(raw ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  if (folded.startsWith("red") || folded === "tinto" || folded === "rosso") return "red";
  if (folded.startsWith("white") || folded === "blanco" || folded === "blanc") return "white";
  if (folded.startsWith("rose") || folded === "rosado" || folded === "pink") return "rose";

  const hint = (itemHint ?? "").toLowerCase();
  if (/\bros[eé]\b|\brosado\b|\bpink\b/.test(hint)) return "rose";
  if (
    /\b(chardonnay|sauvignon|riesling|pinot grigio|pinot gris|albari|verdejo|soave|prosecco|champagne|blanc)\b/.test(
      hint
    )
  ) {
    return "white";
  }
  return "red";
}

function parseFlavorItem(raw: unknown): FlavorCircle | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const name = String(item.name ?? item.label ?? item.flavor ?? "").trim();
  if (!name) return null;
  const intensityRaw = Number(item.intensity ?? item.size ?? item.level);
  const intensity = [1, 2, 3].includes(intensityRaw)
    ? (intensityRaw as FlavorIntensity)
    : null;
  if (intensity == null) return null;
  return {
    name,
    intensity,
    family: normalizeFamily(item.family ?? item.color_family ?? item.colorFamily),
  };
}

/** Always returns exactly 3 flavors with distinct intensities 1, 2, and 3. */
export function normalizeFlavors(
  raw: unknown,
  tasteProfileFallback?: unknown
): FlavorCircle[] {
  const fromStructured = (Array.isArray(raw) ? raw : [])
    .map(parseFlavorItem)
    .filter((f): f is FlavorCircle => f != null);

  const fromLegacy = (Array.isArray(tasteProfileFallback) ? tasteProfileFallback : [])
    .map((item, index) => {
      if (item && typeof item === "object") return parseFlavorItem(item);
      const name = String(item ?? "").trim();
      if (!name) return null;
      const intensity = ([3, 2, 1][index] ?? 1) as FlavorIntensity;
      return { name, intensity, family: normalizeFamily(undefined) } satisfies FlavorCircle;
    })
    .filter((f): f is FlavorCircle => f != null);

  const pool = [...fromStructured, ...fromLegacy, ...DEFAULT_FLAVORS];
  const picked: FlavorCircle[] = [];
  const usedNames = new Set<string>();
  for (const flavor of pool) {
    const key = flavor.name.toLowerCase();
    if (usedNames.has(key)) continue;
    usedNames.add(key);
    picked.push(flavor);
    if (picked.length === 3) break;
  }

  while (picked.length < 3) {
    picked.push(DEFAULT_FLAVORS[picked.length]);
  }

  // Assign unique intensities by prominence: keep preferred intensity when
  // free, otherwise fill remaining slots from 3 → 1.
  const sorted = [...picked].sort(
    (a, b) => b.intensity - a.intensity || a.name.localeCompare(b.name)
  );
  const used = new Set<FlavorIntensity>();
  const intensityPool: FlavorIntensity[] = [3, 2, 1];
  return sorted.slice(0, 3).map((flavor) => {
    if (!used.has(flavor.intensity)) {
      used.add(flavor.intensity);
      return flavor;
    }
    const next = intensityPool.find((v) => !used.has(v)) ?? 1;
    used.add(next);
    return { ...flavor, intensity: next };
  });
}

function firstSentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const match = trimmed.match(/^[^.!?]+[.!?]?/);
  return (match ? match[0] : trimmed).trim();
}

export function buildTasteSummaryFallback(
  tastingNotes: string,
  flavors: FlavorCircle[]
): string {
  const fromNotes = firstSentence(tastingNotes);
  if (fromNotes && fromNotes.length <= 160) return fromNotes;
  if (fromNotes) return `${fromNotes.slice(0, 157).trim()}...`;
  const names = flavors.map((f) => f.name.toLowerCase());
  return `A ${names.slice(0, 2).join(" and ")} profile with a touch of ${names[2] ?? "earth"}.`;
}

export function hasStructuredFlavors(extraData: unknown): boolean {
  if (!extraData || typeof extraData !== "object") return false;
  const flavors = (extraData as Record<string, unknown>).flavors;
  if (!Array.isArray(flavors) || flavors.length < 3) return false;
  return flavors.every((item) => parseFlavorItem(item) != null);
}

/** Preserve staff-authored keys from an existing extraData blob when writing
 * a fresh AI enrichment onto Wine.extraData. CompanyWine.extraData is never
 * touched by the AI path — this is a safety net for keys that landed on the
 * generic wine row. */
export function mergeEnrichmentPreservingStaff(
  existing: unknown,
  enrichment: EnrichmentData
): Record<string, unknown> {
  const prev = (existing && typeof existing === "object"
    ? (existing as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  const next: Record<string, unknown> = { ...enrichment };
  for (const key of STAFF_EXTRA_DATA_KEYS) {
    if (prev[key] != null && prev[key] !== "") {
      next[key] = prev[key];
    }
  }
  return next;
}

export function normalizeEnrichment(
  parsed: Record<string, unknown>,
  opts?: { itemName?: string }
): EnrichmentData {
  const tastingNotes = String(
    parsed.tasting_notes ?? "A well-crafted wine worth exploring."
  );
  const flavors = normalizeFlavors(parsed.flavors ?? parsed.flavor_circles, parsed.taste_profile);
  const tasteSummaryRaw = String(
    parsed.taste_summary ?? parsed.profile_summary ?? ""
  ).trim();
  const tasteSummary =
    tasteSummaryRaw || buildTasteSummaryFallback(tastingNotes, flavors);

  return {
    tasting_notes: tastingNotes,
    taste_summary: tasteSummary,
    flavors,
    taste_profile: flavors.map((f) => f.name),
    pairs_well_with: Array.isArray(parsed.pairs_well_with)
      ? parsed.pairs_well_with.map(String).slice(0, 5)
      : ["Pasta", "Cheese", "Grilled meats"],
    variety: parsed.variety != null ? String(parsed.variety) : null,
    region: parsed.region != null ? String(parsed.region) : null,
    country: parsed.country != null ? String(parsed.country) : null,
    wine_type: normalizeWineType(parsed.wine_type ?? parsed.wine_color ?? parsed.color, opts?.itemName),
    body: clampScale(parsed.body, 3),
    acidity: clampScale(parsed.acidity, 3),
    tannin: clampScale(parsed.tannin, 3),
    sweetness: clampScale(parsed.sweetness, 1),
    fruity_earthy: clampScale(parsed.fruity_earthy ?? parsed.fruit_to_earth, 3),
    crisp_creamy: clampScale(parsed.crisp_creamy ?? parsed.texture, 3),
    dryness_label: String(parsed.dryness_label ?? "Dry"),
    provenance: parsed.provenance === "verified" ? "verified" : "inferred",
  };
}

export const ENRICHMENT_FIELDS_PROMPT = [
  "tasting_notes (2-3 sentences)",
  'taste_summary (exactly 1 short sentence summarizing the Taste Profile for the UI, e.g. "Smooth and fruit-forward, with ripe red fruit, a little spice and a silky finish.")',
  'flavors (array of EXACTLY 3 objects: {"name": short label like "Cherry", "intensity": 1|2|3 with each value used once, "family": one of red_fruit|black_fruit|citrus|stone_tropical|floral|herbal|spice|earth_mineral}. intensity 3 = dominant)',
  "pairs_well_with (array of 3 foods)",
  "variety, region, country",
  'wine_type ("red" | "white" | "rose")',
  "body/acidity/tannin/sweetness/fruity_earthy/crisp_creamy (1-5 integers)",
  'dryness_label (e.g. "Dry")',
  'provenance ("verified" or "inferred")',
  "Do NOT generate why_we_love_it or from_the_team — staff writes those separately",
].join("; ");
