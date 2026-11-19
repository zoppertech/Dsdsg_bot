import type { Metadata } from "next";
import VoiceBot from "@/components/VoiceBot";
import { CUSTOMER_UI } from "@/lib/botUi";

export const metadata: Metadata = {
  title: "Zopper Device Secure Assistant",
};

export default function CustomerPage() {
  return <VoiceBot ui={CUSTOMER_UI} />;
}
