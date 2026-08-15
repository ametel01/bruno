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
  "THESIS: Bruno edits a founder's scattered company into one daily operating page, refusing the AI-category hero plus floating chat screenshot.",
  "OWN-WORLD: Grid-ruled stock, dark ledger ink, electric editorial blue, citron tabs, square rules, and compressed display lettering.",
  "STORY: See today's decisions, enter the shipped dashboard, understand the Business Graph behind them, then trust explicit policies and verification.",
  "FIRST VIEWPORT: A dated two-page spread pairs Bruno's promise with three illustrative decisions; the primary action opens the dashboard, agent creation is directly adjacent, and a graph route crosses the fold.",
  "FORM: The Company Daybook, grounded direction 1; seed 2b573c57.",
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
