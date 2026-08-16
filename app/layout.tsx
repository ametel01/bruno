import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { AuthConfigurationUnavailable } from "@/app/_components/auth-configuration-unavailable";
import { resolveAuthMode } from "@/src/auth/server-auth-mode";
import "@xterm/xterm/css/xterm.css";
import "./globals.css";

const bodyFont = Inter({
  subsets: ["latin"],
  variable: "--font-bruno-body",
});

const DIRECTION_CONTRACT = [
  "THESIS: Bruno keeps a one-person company in motion through one calm operating loop, refusing AI glow, chatbot theater, and ledger spectacle.",
  "OWN-WORLD: Ivory and stone fields, deep-charcoal Satoshi, warm espresso rules, mint and lime signals, orbital linework, and softly precise product panels.",
  "STORY: Understand Bruno's role, see the Action Inbox and Business Graph at work, then enter the shipped dashboard or create an agent.",
  "FIRST VIEWPORT: A quiet navigation bar leads into an oversized promise and two clear actions beside a high-fidelity illustrative Action Inbox crossed by Bruno's circular signal pattern.",
  "FORM: Calm Operations Brandboard, the user-pinned hard reference; landing seed b32744ed. Existing authenticated surfaces migrate in later phases.",
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
      <head>
        <link rel="preconnect" href="https://api.fontshare.com" />
        <link
          href="https://api.fontshare.com/v2/css?f[]=satoshi@500,600,700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className={bodyFont.variable} data-impeccable-seed="b32744ed">
        <script>{directionContractBootstrap}</script>
        {content}
      </body>
    </html>
  );
}
