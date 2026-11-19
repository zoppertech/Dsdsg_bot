import type { Metadata, Viewport } from "next";
import { Baloo_2, Hind } from "next/font/google";
import "./globals.css";

const baloo = Baloo_2({ subsets: ["latin", "devanagari"], weight: ["600", "700"], variable: "--font-baloo" });
const hind = Hind({ subsets: ["latin", "devanagari"], weight: ["400", "500", "600"], variable: "--font-hind" });

export const metadata: Metadata = {
  title: "Zopper AI Assistant",
  description: "Talk to Zopper about Device Secure and Device Secure Gold",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#121A3D",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${baloo.variable} ${hind.variable}`}>
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
