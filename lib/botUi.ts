// Text shown on screen for each bot. Safe to use in the browser (no secrets here).
export type BotUi = {
  bot: "customer" | "promoter";
  name: string;
  badge: string;
  headline: string;
  tagline: string;
  suggestions: string[];
};

export const CUSTOMER_UI: BotUi = {
  bot: "customer",
  name: "Device Secure Assistant",
  badge: "For customers",
  headline: "Protect every device at home",
  tagline: "Ask me anything about Device Secure and Device Secure Gold: plans, coverage and claims.",
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
  suggestions: [
    "How do I pitch DSG to a customer?",
    "Customer says it's too expensive",
    "What are my incentive slabs?",
    "How does the claim process work?",
  ],
};

export const HELPLINE_DISPLAY = "7272-858-858";
export const HELPLINE_TEL = "tel:+917272858858";
