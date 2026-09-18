// design.md §6.4's script routing: "if the line's character set detection or page `lang` suggests
// Devanagari, use the Devanagari recognizer when bundled." Routing happens before recognition (a
// detected text-LINE crop carries no text yet — that is what recognition produces), so the only
// signal available at routing time is the page's own declared language, not the line's content.
// [A] "Character set detection" (design.md's other named signal) would need to inspect nearby DOM
// text or run a cheap script-classifier over the crop itself — not built here; BCP-47 `lang`
// routing alone is what T-6.4's own acceptance criterion asks for ("a Devanagari PAGE routes to
// the Devanagari recognizer"), and covers every corpus fixture design.md/eval/corpus's Indic
// category actually exercises (each fixture declares a real `lang`/`script` per its `meta.json`).

export type OcrScript = 'latin' | 'devanagari';

// BCP-47 primary language subtags for languages that use the Devanagari script as their default
// or a common script (Hindi, Marathi, Nepali, Sanskrit, Konkani, Bodo, Maithili, Dogri) — design
// doc's own Indic test category (Kannada/Telugu/Gujarati/Malayalam/Punjabi/Bengali/Tamil/Odia
// pages exist in the corpus too, but PP-OCRv5's bundled recognizer set here is Latin+Devanagari
// only; a page in one of those other scripts routes to 'latin' today, which will garble its text
// rather than silently claim a recognizer that isn't bundled — a disclosed gap, not a silent one,
// tracked against "when bundled" in design.md's own wording).
const DEVANAGARI_LANG_PREFIXES = ['hi', 'mr', 'ne', 'sa', 'kok', 'brx', 'mai', 'doi'];

/** `pageLang` is the page's own `<html lang>` (or an explicit BCP-47 override), lowercased,
 * exactly as `sanitized-context.schema.json`'s page metadata would carry it. `undefined`/empty
 * defaults to Latin — the same fail-toward-the-common-case choice as an unset `dir` attribute
 * defaulting to ltr. */
export function routeScript(pageLang: string | undefined): OcrScript {
  if (!pageLang) return 'latin';
  const primary = pageLang.toLowerCase().split('-')[0]!;
  return DEVANAGARI_LANG_PREFIXES.includes(primary) ? 'devanagari' : 'latin';
}
