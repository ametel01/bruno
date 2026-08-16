import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata } from "next";
import { Inter } from "next/font/google";
import Script from "next/script";
import { AuthConfigurationUnavailable } from "@/app/_components/auth-configuration-unavailable";
import { resolveAuthMode } from "@/src/auth/server-auth-mode";
import "@xterm/xterm/css/xterm.css";
import "./globals.css";

const bodyFont = Inter({
  subsets: ["latin"],
  variable: "--font-bruno-body",
});

const DIRECTION_CONTRACT = [
  "THESIS: Bruno.Ai is the always-on AI agent that keeps a one-person company in motion, learns from the founder, and improves through one calm operating loop.",
  "OWN-WORLD: Ivory and stone fields, deep-charcoal Satoshi, warm espresso rules, mint and lime signals, orbital linework, and softly precise product panels.",
  "STORY: Understand Bruno.Ai's 24/7 role and learning loop, see the Action Inbox and Business Graph at work, then enter the shipped dashboard or create an agent.",
  "FIRST VIEWPORT: Public pages open with the always-on promise; authenticated pages open with a compact Bruno.Ai rail, route title, calm live presence, operational pulse, and the first actionable work surface.",
  "FORM: Calm Operations Brandboard, the user-pinned hard reference; seed b32744ed. Dashboard, agents, and settings use the same ivory, espresso, mint, and lime operating world in a denser product mode.",
  "FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, and DESIGN.md",
].join("\n");

const directionContractBootstrap = `document.body.prepend(document.createComment(${JSON.stringify(DIRECTION_CONTRACT)}));`;

export const metadata: Metadata = {
  title: "Bruno.Ai",
  description:
    "Bruno.Ai is the always-on AI agent that learns how to run your one-person company with you.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const authMode = resolveAuthMode(process.env);
  let content = children;

  if (authMode.mode === "clerk") {
    content = (
      <ClerkProvider
        publishableKey={authMode.publishableKey}
        signInUrl="/sign-in"
        signUpUrl="/sign-up"
      >
        {children}
      </ClerkProvider>
    );
  } else if (authMode.mode === "invalid") {
    content = <AuthConfigurationUnavailable />;
  }

  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://api.fontshare.com" />
        <link
          href="https://api.fontshare.com/v2/css?f[]=satoshi@500,600,700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className={bodyFont.variable} data-impeccable-seed="b32744ed">
        <Script id="direction-contract" strategy="afterInteractive">
          {directionContractBootstrap}
        </Script>
        {content}
      </body>
    </html>
  );
}
