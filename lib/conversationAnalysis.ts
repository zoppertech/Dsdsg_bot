import "server-only";
import type { ConfirmQuestion, LoggedTurn } from "@/lib/mongodb";

/** Lowercase, no punctuation, single spaces: so "Kya X covered hai?" and "kya x covered hai" group together. */
function questionKey(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu, " ").trim();
}

// ---------- "I'll confirm with the team" detection ----------
// Matches the phrases the prompts tell the bot to use (prompts/customer.md and promoter.md),
// plus English and Devanagari variants, since the transcript may come back in either script.
// If you change those phrases in the prompts, update this list too.
// "confirm/check/verify" (any script) within a few words of "team", in either order.
const CONFIRM_WORD = String.raw`(?:confirm|check|verify|(?:कन्|कं)फ़?र्म|पुष्टि|चेक)`;
const TEAM_WORD = String.raw`(?:team|टीम)`;
const NEAR = String.raw`[^.?!।]{0,40}?`;

const CONFIRM_PATTERNS: RegExp[] = [
  new RegExp(`${CONFIRM_WORD}${NEAR}${TEAM_WORD}`, "i"), // "confirm with the team", "confirmed by the team"
  new RegExp(`${TEAM_WORD}${NEAR}${CONFIRM_WORD}`, "i"), // "team se confirm karwa deta hoon", "टीम से कंफर्म", "टीमकडून कन्फर्म"
  /confirm\s+kar(wa|va)/i, // "confirm karwa deta hoon" (team not named)
  /(कन्|कं)फ़?र्म\s*(करवा|करा\s|करा$|कराऊ|करवाऊ|करून)/,
  /team\s+tak\s+pahu?n?cha/i, // "Yeh main team tak pahuncha deta hoon"
  /टीम\s*तक\s*पहु/,
];

export function saysWillConfirm(text: string): boolean {
  return CONFIRM_PATTERNS.some((p) => p.test(text));
}

/** For every bot reply that says "I'll confirm with the team", the user message just before it. */
export function findConfirmQuestions(turns: LoggedTurn[]): { flagged: boolean; questions: ConfirmQuestion[] } {
  let flagged = false;
  const questions: ConfirmQuestion[] = [];
  let lastUser: string | null = null;
  for (const t of turns) {
    if (t.role === "user") {
      lastUser = t.text;
    } else if (saysWillConfirm(t.text)) {
      flagged = true;
      if (lastUser) {
        const text = lastUser.trim().slice(0, 300);
        questions.push({ text, key: questionKey(text) });
      }
      lastUser = null; // don't count the same question twice
    }
  }
  return { flagged, questions };
}

// ---------- language detection (simple heuristic, user messages only) ----------
const SCRIPTS: [string, RegExp][] = [
  ["Hindi", /[ऀ-ॿ]/g], // Devanagari (Hindi / Marathi)
  ["Bengali", /[ঀ-৿]/g],
  ["Punjabi", /[਀-੿]/g],
  ["Gujarati", /[઀-૿]/g],
  ["Odia", /[଀-୿]/g],
  ["Tamil", /[஀-௿]/g],
  ["Telugu", /[ఀ-౿]/g],
  ["Kannada", /[ಀ-೿]/g],
  ["Malayalam", /[ഀ-ൿ]/g],
  ["Latin", /[a-z]/gi],
];

// Common Hindi words written in English letters. Several of these in a Latin-script
// message means Hinglish rather than English.
const HINGLISH_WORDS = new Set(
  "hai hain kya kaise kitna kitne kitni nahi nahin mein mera meri mere aap aapka apna hum ham ko ka ki ke se bhi toh to ye yeh wo woh kab kahan kyun kyu karna karo kare karte chahiye hoga hogi milega lena dena batao bataiye accha acha theek thik haan ji sab agar lekin aur par phir abhi"
    .split(" "),
);

// Marathi and Hindi share the Devanagari script, so count words that only one of them uses.
const MARATHI_WORDS = new Set("आहे आहेत नाही मला तुम्ही तुमचा तुमची तुमच्या काय कसं कसे कसा आणि पाहिजे होतं झालं करू द्या मी आम्ही माझा माझी माझे कधी कुठे म्हणजे".split(" "));
const HINDI_WORDS = new Set("है हैं नहीं मुझे मेरा मेरी मेरे आप आपका आपकी क्या कैसे और चाहिए हूँ हूं था थी गया करना कब कहाँ कहां यह वह".split(" "));

/** "Hindi", "Marathi", or "Hindi + Marathi" when both appear about equally. */
function devanagariLanguage(text: string): string {
  const words = text.split(/[^\p{L}\p{M}]+/u);
  const mr = words.filter((w) => MARATHI_WORDS.has(w)).length;
  const hi = words.filter((w) => HINDI_WORDS.has(w)).length;
  if (mr > 0 && hi > 0 && Math.min(mr, hi) / Math.max(mr, hi) > 0.5) return "Hindi + Marathi";
  return mr > hi ? "Marathi" : "Hindi";
}

export function detectLanguage(turns: LoggedTurn[]): string {
  const text = turns.filter((t) => t.role === "user").map((t) => t.text).join(" ");
  if (!text.trim()) return "unknown";

  const counts = SCRIPTS.map(([name, re]) => [name, text.match(re)?.length ?? 0] as const);
  const total = counts.reduce((s, [, n]) => s + n, 0);
  if (total === 0) return "unknown";
  const [top, topCount] = counts.reduce((a, b) => (b[1] > a[1] ? b : a));

  if (top !== "Latin") {
    // Lots of English letters mixed in with Devanagari = Hinglish.
    const latin = counts.find(([n]) => n === "Latin")?.[1] ?? 0;
    if (top === "Hindi" && latin / total > 0.3) return "Hinglish";
    if (top === "Hindi") return devanagariLanguage(text);
    return top;
  }
  if (topCount / total < 0.7) return "Mixed";

  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  const hindiWords = words.filter((w) => HINGLISH_WORDS.has(w)).length;
  return words.length > 0 && hindiWords / words.length >= 0.15 ? "Hinglish" : "English";
}
