import { GenerateContentRequest, GoogleGenerativeAI, Part } from "@google/generative-ai";

const DEFAULT_MODELS = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-2.5-flash-lite"];

function getModelCandidates(): string[] {
  if (process.env.GEMINI_MODEL) {
    return [process.env.GEMINI_MODEL];
  }
  return DEFAULT_MODELS;
}

function getApiKey(): string {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!key) {
    throw new Error("GEMINI_API_KEY not configured");
  }
  return key;
}

function getModel(modelName: string, jsonMode = false) {
  const genAI = new GoogleGenerativeAI(getApiKey());
  return genAI.getGenerativeModel({
    model: modelName,
    generationConfig: jsonMode
      ? { responseMimeType: "application/json", maxOutputTokens: 32768 }
      : undefined,
  });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isQuotaError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("429") || message.toLowerCase().includes("quota");
}

function isOverloadedError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  return (
    message.includes("503") ||
    message.includes("500") ||
    lower.includes("overloaded") ||
    lower.includes("service unavailable") ||
    lower.includes("fetch failed")
  );
}

function isTransientError(err: unknown): boolean {
  return isQuotaError(err) || isOverloadedError(err);
}

function parseRetryDelayMs(err: unknown): number | null {
  const message = err instanceof Error ? err.message : String(err);
  const secondsMatch = message.match(/retry in ([\d.]+)s/i);
  if (secondsMatch) {
    return Math.ceil(Number(secondsMatch[1]) * 1000);
  }
  return null;
}

function formatGeminiError(err: unknown): Error {
  if (isQuotaError(err)) {
    return new Error(
      "Cuota de Gemini agotada. Esperá unos minutos o cambiá GEMINI_MODEL en .env (ej: gemini-2.5-flash). Más info: https://ai.google.dev/gemini-api/docs/rate-limits"
    );
  }
  if (isOverloadedError(err)) {
    return new Error(
      "El modelo de Gemini está temporalmente sobrecargado. Probá de nuevo en unos segundos."
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}

async function generateText(
  content: GenerateContentRequest | Part[] | string,
  jsonMode = false
): Promise<string> {
  let lastError: unknown;

  for (const modelName of getModelCandidates()) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const attemptStartedAt = Date.now();
      try {
        const model = getModel(modelName, jsonMode);
        const result = await model.generateContent(content);
        console.log(
          `Gemini call: model=${modelName} attempt=${attempt} took ${Date.now() - attemptStartedAt}ms`
        );
        return result.response.text();
      } catch (err) {
        lastError = err;
        const message = err instanceof Error ? err.message : String(err);
        if (!isTransientError(err)) {
          console.log(
            `Gemini call: model=${modelName} attempt=${attempt} failed (non-transient) after ${Date.now() - attemptStartedAt}ms: ${message}`
          );
          throw formatGeminiError(err);
        }
        if (attempt < 2) {
          const delay = parseRetryDelayMs(err) ?? (attempt + 1) * 5000;
          console.log(
            `Gemini call: model=${modelName} attempt=${attempt} failed (transient) after ${Date.now() - attemptStartedAt}ms: ${message} — retrying in ${delay}ms`
          );
          await sleep(delay);
        }
      }
    }
  }

  throw formatGeminiError(lastError);
}

function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  return fenced ? fenced[1].trim() : trimmed;
}

function extractJsonSpan(text: string, open: string, close: string): string | null {
  const start = text.indexOf(open);
  const end = text.lastIndexOf(close);
  if (start === -1 || end === -1 || end < start) return null;
  return text.slice(start, end + 1);
}

function parseJsonArrayFromText(text: string): unknown[] {
  const cleaned = stripJsonFence(text);
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    const span = extractJsonSpan(cleaned, "[", "]");
    if (span) return JSON.parse(span);
    throw err;
  }
}

export function hasGeminiApiKey(): boolean {
  return !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
}

export interface LabelExtraction {
  producer: string;
  wineName: string;
  vintage: string | null;
  region: string | null;
  country: string | null;
  variety: string | null;
  fullText: string;
  confidence: number;
  /** Separate from `confidence` (how well the text could be read) — whether
   * this photo itself is good enough to show as the product photo (in
   * focus, well-lit, not excessively glared/cropped). Used to gate
   * auto-saving a customer's scan as the wine's image. */
  photoUsable: boolean;
}

/** Returns one entry per bottle. Almost always a single-element array — only
 * returns more than one when the photo genuinely shows multiple bottles that
 * are equally in focus and readable. */
export async function extractLabelsFromImage(
  imageBase64: string,
  mimeType = "image/jpeg"
): Promise<LabelExtraction[]> {
  const content = await generateText(
    [
      {
        text: `Wine label OCR. Ignore bottles that are blurry, in the background, or whose label has less than half its width visible in frame (e.g. a neighboring bottle cut off at the edge) — those aren't the one the user meant to scan. Still do your best to read the main/foreground bottle(s) even if just a letter or corner of the label is clipped by the frame. If 2+ bottles have most of their label visible and in focus, one entry per bottle.
Per bottle: producer, wineName, vintage (year|null), region, country, variety, fullText (all visible text), confidence (0-1).
Also rate photoUsable (boolean): true only if this specific photo is good enough to show elsewhere as the product photo for this bottle — in focus, well-lit, not excessively glared or cropped, whole bottle roughly visible. Independent from confidence: a photo can be a clean, easy OCR read (high confidence) while still being unusable as a product photo (extreme close-up of just the text, heavy glare, tilted/cropped bottle), and vice versa.
Best-effort extract even if uncertain — low confidence, not empty fields, unless no label is readable at all.
Return only a JSON array.`,
      },
      {
        inlineData: {
          data: imageBase64,
          mimeType,
        },
      },
    ],
    true
  );

  const parsed = parseJsonArrayFromText(content) as Record<string, unknown>[];

  return parsed.map((parsed_) => ({
    producer: String(parsed_.producer ?? ""),
    wineName: String(parsed_.wineName ?? ""),
    vintage: parsed_.vintage != null ? String(parsed_.vintage) : null,
    region: parsed_.region != null ? String(parsed_.region) : null,
    country: parsed_.country != null ? String(parsed_.country) : null,
    variety: parsed_.variety != null ? String(parsed_.variety) : null,
    fullText: String(
      parsed_.fullText ?? `${parsed_.producer ?? ""} ${parsed_.wineName ?? ""}`.trim()
    ),
    confidence: Number(parsed_.confidence ?? 0.5),
    // Default false (not true) when the model omits the field — an unusable
    // photo should never be assumed fine just because the model didn't say.
    photoUsable: parsed_.photoUsable === true,
  }));
}

export interface EnrichmentData {
  tasting_notes: string;
  taste_profile: string[];
  pairs_well_with: string[];
  variety: string | null;
  region: string | null;
  country: string | null;
  body: number;
  acidity: number;
  tannin: number;
  sweetness: number;
  dryness_label: string;
  why_we_love_it: string;
  from_the_team: string;
  provenance: "verified" | "inferred";
}

const ENRICHMENT_FIELDS_PROMPT =
  'tasting_notes (2-3 sentences), taste_profile (array of 3 flavor words), pairs_well_with (array of 3 foods), variety, region, country, body/acidity/tannin/sweetness (1-5 integers), dryness_label (e.g. "Dry"), why_we_love_it (1 friendly sentence), from_the_team (1 sentence staff quote), provenance ("verified" or "inferred")';

function parseEnrichmentRow(parsed: Record<string, unknown>): EnrichmentData {
  return {
    tasting_notes: String(parsed.tasting_notes ?? "A well-crafted wine worth exploring."),
    taste_profile: Array.isArray(parsed.taste_profile)
      ? parsed.taste_profile.map(String)
      : ["Fruit", "Earth", "Spice"],
    pairs_well_with: Array.isArray(parsed.pairs_well_with)
      ? parsed.pairs_well_with.map(String)
      : ["Pasta", "Cheese", "Grilled meats"],
    variety: parsed.variety != null ? String(parsed.variety) : null,
    region: parsed.region != null ? String(parsed.region) : null,
    country: parsed.country != null ? String(parsed.country) : null,
    body: Math.min(5, Math.max(1, Number(parsed.body ?? 3))),
    acidity: Math.min(5, Math.max(1, Number(parsed.acidity ?? 3))),
    tannin: Math.min(5, Math.max(1, Number(parsed.tannin ?? 3))),
    sweetness: Math.min(5, Math.max(1, Number(parsed.sweetness ?? 1))),
    dryness_label: String(parsed.dryness_label ?? "Dry"),
    why_we_love_it: String(
      parsed.why_we_love_it ?? "A customer favorite from our Italian selection."
    ),
    from_the_team: String(parsed.from_the_team ?? "Great value and easy to enjoy."),
    provenance: parsed.provenance === "verified" ? "verified" : "inferred",
  };
}

export interface WineClassification {
  isWine: boolean;
  section: string | null;
  enrichment: EnrichmentData | null;
}

/** Single-pass classifier: decides is_wine, then section, then (if it
 * qualifies) generates full enrichment — one Gemini call per batch. Ported
 * from wines-be-node's classifyAndEnrichWines; keyed on Wine.id here since
 * the generic Wine catalog has no lookup_code of its own in this schema
 * (that lives on CompanyWine, per-company), and takes no price for the same
 * reason. The AI's is_wine call overrides the cheap keyword heuristic used
 * at CSV-import time. */
export async function classifyAndEnrichWines(
  wines: { id: string; itemName: string }[],
  sections: string[]
): Promise<Map<string, WineClassification>> {
  const list = wines.map((w) => `${w.id}\t${w.itemName}`).join("\n");

  const sectionEnum = [...sections.map((s) => `"${s}"`), '"other"'].join(" | ");
  const sectionList = sections.join(", ");

  const content = await generateText(
    `You are a liquor store inventory classifier and sommelier. Each line below is an abbreviated POS item as "id<TAB>item_name".

For each item decide, in order:
1. is_wine: true only if this is an actual wine bottle — not a spirit, beer, cider, hard seltzer, or wine cooler/RTD.
2. section: only if is_wine is true, infer the country of origin from the brand/name (use your knowledge of real wine producers and appellations — abbreviated names may be misleading, e.g. "Concha y Toro" and "Toro de Piedra" are Chilean despite containing "Toro"). Use one of [${sectionList}] only if genuinely confident; otherwise "other". If is_wine is false, section must be "other".
3. enrichment: only if is_wine is true AND section is one of [${sectionList}], generate: ${ENRICHMENT_FIELDS_PROMPT}. Otherwise enrichment must be null.
Be honest — don't invent specific vineyard details. Keep notes practical for a store shopper.

Return ONLY a JSON array, one object per item: {"id": string, "is_wine": boolean, "section": ${sectionEnum}, "enrichment": {...} | null}.

${list}`,
    true
  );

  const parsed = parseJsonArrayFromText(content) as {
    id: string;
    is_wine: boolean;
    section: string;
    enrichment: Record<string, unknown> | null;
  }[];

  const result = new Map<string, WineClassification>();
  for (const row of parsed) {
    const isWine = Boolean(row.is_wine);
    const section = isWine && sections.includes(row.section) ? row.section : null;
    const enrichment = isWine && section && row.enrichment ? parseEnrichmentRow(row.enrichment) : null;
    result.set(String(row.id), { isWine, section, enrichment });
  }
  return result;
}

export interface LabelDisambiguationInput {
  producer?: string;
  wineName?: string;
  vintage?: string | null;
  region?: string | null;
  variety?: string | null;
  fullText?: string;
}

/** Second step of label scanning: given a short, pre-filtered pool of
 * candidate inventory items, ask the model to pick the one that's actually
 * the same wine — or none. Never send the whole catalog here. */
export async function disambiguateWineMatch(
  extracted: LabelDisambiguationInput,
  candidates: { lookupCode: string; itemName: string }[]
): Promise<{ lookupCode: string; confidence: number } | null> {
  if (candidates.length === 0) return null;

  const candidateList = candidates.map((c) => `${c.lookupCode}\t${c.itemName}`).join("\n");

  const content = await generateText(
    `You are matching a scanned wine bottle label to a liquor store's inventory. The label was read via OCR:
Producer: ${extracted.producer ?? "unknown"}
Wine name: ${extracted.wineName ?? "unknown"}
Vintage: ${extracted.vintage ?? "unknown"}
Region: ${extracted.region ?? "unknown"}
Variety: ${extracted.variety ?? "unknown"}
Full label text: ${extracted.fullText ?? "unknown"}

Candidate inventory items, one per line as "lookup_code<TAB>item_name" (abbreviated POS names):
${candidateList}

Pick the lookup_code of the candidate that is the SAME wine as the scanned label. Pay close attention to words that distinguish different wines from the same producer/region (e.g. "Riserva" vs "Classico", "Nobile" vs "Rosso" — these are different products, not typos or OCR noise). If no candidate is confidently the same wine, return lookup_code: null.

Return ONLY JSON: {"lookup_code": string | null, "confidence": number (0-1)}.`,
    true
  );

  const parsed = JSON.parse(stripJsonFence(content)) as {
    lookup_code: string | null;
    confidence: number;
  };
  if (!parsed.lookup_code) return null;

  return { lookupCode: parsed.lookup_code, confidence: Number(parsed.confidence ?? 0.5) };
}
