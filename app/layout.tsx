import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata } from "next";
import { League_Gothic } from "next/font/google";
import { AuthConfigurationUnavailable } from "@/app/_components/auth-configuration-unavailable";
import { resolveAuthMode } from "@/src/auth/server-auth-mode";
import "@xterm/xterm/css/xterm.css";
import "./globals.css";

const displayFont = League_Gothic({
  subsets: ["latin"],
  variable: "--font-bruno-display",
});

const DIRECTION_CONTRACT = [
  "THESIS: Bruno edits a founder's scattered company into one daily operating page, refusing both the AI-category hero and the generic card dashboard.",
  "OWN-WORLD: Grid-ruled stock, dark ledger ink, electric editorial blue, citron tabs, square rules, and compressed display lettering.",
  "STORY: Understand Bruno, then operate through decisions, active work, recent records, and a bounded systems appendix.",
  "FIRST VIEWPORT: The landing opens as a dated spread; Founder Dispatch opens with company pulse and decisions; Agent Roster opens with live roster state before controls and setup.",
  "FORM: The Company Daybook with Founder Dispatch and Agent Roster; landing seed 2b573c57, dashboard seed c9dd9100.",
  "FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, and DESIGN.md",
].join("\n");

const directionContractBootstrap = `document.body.prepend(document.createComment(${JSON.stringify(DIRECTION_CONTRACT)}));`;

export const metadata: Metadata = {
  title: "Bruno",
  description: "Bruno is the operating system for a one-person company.",
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
      <body className={displayFont.variable} data-impeccable-seed="2b573c57">
        <script>{directionContractBootstrap}</script>
        {content}
      </body>
    </html>
  );
}
