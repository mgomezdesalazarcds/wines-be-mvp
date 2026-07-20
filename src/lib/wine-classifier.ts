/** Heuristics to decide whether a POS item is a (750ml) wine bottle. Country/section is decided by AI (see classifyWineSections in ai.ts), not by keywords. */

const SPIRIT_KEYWORDS = [
  "VODKA", "WHISKEY", "WHISKY", "BOURBON", "GIN", "RUM", "TEQUILA", "MEZCAL",
  "BRANDY", "COGNAC", "SCOTCH", "RYE", "LIQUEUR", "SCHNAPPS", "ABSINTHE",
  "MOONSHINE", "EVERCLEAR", "GRAIN ALCOHOL",
];

const BEER_KEYWORDS = [
  "BEER", "ALE", "LAGER", "IPA", "STOUT", "PORTER", "PILSNER", "WHEAT BEER",
  " CIDER", "HARD SELTZER", " SELTZER", " PK NR", " PK CAN", "6 PK", "12 PK",
  "24 PK", "30 PK", "18 PK",
];

const WINE_COOLER_KEYWORDS = [
  "ARBOR MIST", "BOONES", "WILD VINES", "SEAGRAMS ESCAPES", "MIKE'S",
  "WHITE CLAW", "TRULY ", "HIGH NOON",
];

export const GRAPE_AND_STYLE_KEYWORDS = [
  "CHARDONNAY", "CABERNET", "MERLOT", "PINOT NOIR", "PINOT GRIGIO", "PINOT GRIS",
  "SAUVIGNON", "RIESLING", "ZINFANDEL", "SYRAH", "SHIRAZ", "MALBEC", "TEMPRANILLO",
  "GRENACHE", "SANGIOVESE", "BARBERA", "NEBBIOLO", "DOLCETTO", "VERMENTINO",
  "CHIANTI", "BRUNELLO", "BAROLO", "BARBARESCO", "AMARONE", "PROSECCO",
  "SOAVE", "ORVIETO", "FRASCATI", "MONTEPULCIANO", "PRIMITIVO", "NERO D AVOLA",
  "NERO D'AVOLA", "ETNA", "VALPOLICELLA", "LAMBRUSCO", "MOSCATO", "GEWURZTRAMINER",
  "VIOGNIER", "ALBARINO", "ALBARIÑO", "GRUNER VELTLINER", "ROSE", "ROSÉ", "BLANC", "ROUGE",
  "VINO", "WINE", "CUVÉE", "CUVEE", "RISERVA", "CLASSICO", "SUPER TUSCAN",
  "BOLGHERI", "LANGHE", "PIEDMONT", "TUSCANY", "TOSCANA", "VENETO", "SICILY",
  "SICILIA", "PUGLIA", "UMBRIA", "MARCHE", "ABRUZZO",
  "GARNACHA", "MONASTRELL", "MENCIA", "MENCÍA", "VERDEJO", "GODELLO", "BOBAL",
  "CAVA", "RIOJA", "RIBERA DEL DUERO", "PRIORAT", "CRIANZA",
  "SANCERRE", "BORDEAUX", "BOURGOGNE", "BURGUNDY", "CHAMPAGNE", "CHABLIS",
  "BEAUJOLAIS", "LOIRE", "PROVENCE", "MEDOC", "MÉDOC", "POUILLY", "MUSCADET",
  "CHINON", "MARGAUX", "SAINT EMILION", "SAINT-ÉMILION", "POMEROL", "CREMANT",
  "CRÉMANT", "COTES DU RHONE", "CÔTES DU RHÔNE", "CHATEAUNEUF", "CHÂTEAUNEUF",
  "ALSACE", "GRAVES", "SAUTERNES",
];

export function cleanField(value: string | undefined | null): string {
  if (!value) return "";
  return value.replace(/[\t\r\n]+/g, " ").trim();
}

export function parsePrice(value: string | undefined | null): number {
  const cleaned = cleanField(value).replace(/[^0-9.]/g, "");
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

const WINE_BOTTLE_SIZES = [
  "187 ML", "187ML",
  "375 ML", "375ML",
  "500 ML", "500ML",
  "750 ML", "750ML",
  "1 L", "1L",
  "1.5 L", "1.5L",
  "1.75 L", "1.75L",
  "3 L", "3L",
];

export function isWineBottleSize(size: string): boolean {
  const s = cleanField(size).toUpperCase();
  return WINE_BOTTLE_SIZES.includes(s);
}

/** "750 ML" and "750ML" are the same size but different strings — since
 * `size` is now part of a generic Wine's identity (import-time dedup keys on
 * name + size), collapse whitespace/case before comparing or storing so
 * formatting differences across POS exports don't create duplicate Wines. */
export function normalizeSize(size: string | undefined | null): string | null {
  const cleaned = cleanField(size).toUpperCase().replace(/\s+/g, "");
  return cleaned || null;
}

function matchesExactKeywords(text: string, keywords: string[]): boolean {
  const cleanKeywords = keywords
    .map(kw => kw.trim())
    .filter(kw => kw.length > 0)
    .map(kw => kw.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'));

  if (cleanKeywords.length === 0) return false;

  const pattern = `\\b(${cleanKeywords.join('|')})\\b`;
  const regex = new RegExp(pattern, 'i');
  return regex.test(text);
}

/** Cheap exclusion pass: right bottle size and not obviously a spirit/beer/cooler by name.
 * Does not confirm it IS wine — just that it's worth asking the keyword list (or the AI). */
export function isWineCandidate(itemName: string, size: string): boolean {
  const name = itemName.toUpperCase();

  if (!isWineBottleSize(size)) return false;
  if (matchesExactKeywords(name, SPIRIT_KEYWORDS)) return false;
  if (matchesExactKeywords(name, BEER_KEYWORDS)) return false;
  if (matchesExactKeywords(name, WINE_COOLER_KEYWORDS)) return false;
  if (/\b(80|90|100|101|151)\s*PROOF\b/.test(name)) return false;

  return true;
}

export function isLikelyWine(itemName: string, size: string): boolean {
  if (!isWineCandidate(itemName, size)) return false;
  return matchesExactKeywords(itemName.toUpperCase(), GRAPE_AND_STYLE_KEYWORDS);
}

export function normalizeWineName(name: string): string {
  return cleanField(name)
    .toUpperCase()
    .replace(/[^A-Z0-9\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const GENERIC_NAME_STOPWORDS = new Set([
  "DI", "DE", "DEL", "DELLA", "DELL", "DEI", "DELLE", "LA", "LE", "IL", "LO",
  "D", "THE", "AND", "Y", "E", "DU", "DES", "DAL", "DAI",
]);

const GENERIC_NAME_WORDS = new Set(
  GRAPE_AND_STYLE_KEYWORDS.flatMap((kw) => kw.split(" "))
);

/** Words in a wine name that aren't a grape/style/region term or a filler
 * word — the part of the name likely to be a distinctive cuvée/producer
 * word (e.g. "NOBILE" in "Nobile di Montepulciano"), as opposed to a
 * generic denomination that many different wines share. Use this to decide
 * whether a name is worth searching on its own (see isGenericWineName) —
 * NOT to decide whether a candidate is confirmed correct: a grape/style word
 * dropped here (e.g. "Pinot Grigio") can still be the only thing telling two
 * wines from the SAME producer apart (see requiredMatchTokens). */
export function extractDistinctiveTerms(name: string): string[] {
  const words = normalizeWineName(name).split(" ").filter(Boolean);
  return words.filter(
    (w) => w.length > 2 && !GENERIC_NAME_STOPWORDS.has(w) && !GENERIC_NAME_WORDS.has(w)
  );
}

/** Every meaningful word in a name (producer or wine name) — only filler
 * stopwords are dropped, grape/style keywords are kept. Used to check that a
 * candidate genuinely contains everything the label said, instead of
 * silently dropping words (like a grape variety) that distinguish one wine
 * from another wine by the same producer.
 *
 * `minLength` defaults to 3 (drops 1-2 letter noise words from OCR text).
 * Live search-as-you-type passes 1 instead — there, a short trailing token
 * is usually the start of a word the user hasn't finished typing yet (e.g.
 * "ma" typing toward "Marguerite"), and should still be required. */
export function requiredMatchTokens(name: string, minLength = 3): string[] {
  const words = normalizeWineName(name).split(" ").filter(Boolean);
  return words.filter((w) => w.length >= minLength && !GENERIC_NAME_STOPWORDS.has(w));
}

/** True when a wine name is just a denomination/style (e.g. "Chianti
 * Classico Riserva") with nothing distinctive to anchor a match on —
 * many different wines share exactly that name. */
export function isGenericWineName(name: string): boolean {
  return extractDistinctiveTerms(name).length === 0;
}