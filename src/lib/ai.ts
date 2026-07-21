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
  }));
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
