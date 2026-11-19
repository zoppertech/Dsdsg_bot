import type { Metadata } from "next";
import { notFound } from "next/navigation";
import VoiceBot from "@/components/VoiceBot";
import { PROMOTER_UI } from "@/lib/botUi";
import { isPromoterSecret } from "@/lib/promoterAccess";

// Checked on every request, so changing PROMOTER_PATH_SECRET changes the link.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "DS/DSG Sales Buddy",
  robots: { index: false, follow: false },
};

export default async function PromoterPage({ params }: { params: Promise<{ secret: string }> }) {
  const { secret } = await params;
  if (!isPromoterSecret(secret)) notFound();
  return <VoiceBot ui={PROMOTER_UI} secret={secret} />;
}
