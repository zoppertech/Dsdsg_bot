// Text shown on screen for each bot. Safe to use in the browser (no secrets here).
export type BotUi = {
  bot: "customer" | "promoter";
  name: string;
  badge: string;
  headline: string;
  tagline: string;
  /** Shown instantly as the bot's first message, so the user can start talking right away. */
  greeting: string;
  suggestions: string[];
};

export const CUSTOMER_UI: BotUi = {
  bot: "customer",
  name: "Device Secure Assistant",
  badge: "For customers",
  headline: "Protect every device at home",
  tagline: "Ask me anything about Device Secure and Device Secure Gold: plans, coverage and claims.",
  greeting:
    "Namaste! Main Zopper ka AI assistant hoon. Aaj kya le rahe hain aap? Bataiye, main samjhaata hoon ki use aur ghar ke baaki devices ko tension-free kaise rakh sakte hain.",
  suggestions: [
    "What's the difference between DS and DSG?",
    "Which devices are covered?",
    "How do I raise a claim?",
    "Is it worth it for my new TV?",
  ],
};

export const PROMOTER_UI: BotUi = {
  bot: "promoter",
  name: "DS/DSG Sales Buddy",
  badge: "Promoters · Internal",
  headline: "Your sales buddy on the floor",
  tagline: "Pitch tips, objection handling, incentives and claims, all in one place.",
  greeting:
    "Namaste! Main aapka Zopper Sales Buddy hoon. Pitch ho, incentive ho ya claims, kuch bhi poochho. Aur chaho to main customer ban jaata hoon, ek baar practice kar lete hain!",
  suggestions: [
    "How do I pitch DSG to a customer?",
    "Customer says it's too expensive",
    "What are my incentive slabs?",
    "How does the claim process work?",
  ],
};

export const HELPLINE_DISPLAY = "7272-858-858";
export const HELPLINE_TEL = "tel:+917272858858";
