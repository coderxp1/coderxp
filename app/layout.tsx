import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { GlobalHeader } from "@/components/navigation/GlobalHeader";
import { EnterpriseFooter } from "@/components/navigation/EnterpriseFooter";

const inter = Inter({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  variable: "--font-inter",
  display: "swap",
});

const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-jetbrains",
  display: "swap",
});

export const metadata: Metadata = {
  title: "CoderXP | The Signature AI Software Engineering Workspace",
  description: "AI software engineering workspace in development, built for developers, founders, and teams. Bring-your-own-keys, local LLM bridge, and real execution engine on the roadmap.",
  keywords: ["AI Software Engineer", "BYOK AI", "Developer OS", "Local LLMs", "Next.js AI Workspace"],
  authors: [{ name: "CoderXP Team" }],
  metadataBase: new URL("https://coderxp.pro"),
  alternates: {
    canonical: "/",
  },
  openGraph: {
    title: "CoderXP | The Signature AI Software Engineering Workspace",
    description: "Handcrafted, ultra-premium AI software engineering workspace built for developers, founders, and teams.",
    url: "https://coderxp.pro",
    siteName: "CoderXP",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "CoderXP | The Signature AI Software Engineering Workspace",
    description: "AI software engineering workspace in development. BYOK, local LLM bridge, and real execution engine on the roadmap.",
  },
  robots: {
    index: true,
    follow: true,
  },
};

export const viewport: Viewport = {
  themeColor: "#07090E",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`dark ${inter.variable} ${jetbrains.variable}`}>
      <body className="bg-obsidian text-gray-100 min-h-screen flex flex-col antialiased selection:bg-accent-cyan/30 selection:text-white">
        <GlobalHeader />
        <main className="flex-1 flex flex-col">{children}</main>
        <EnterpriseFooter />
      </body>
    </html>
  );
}