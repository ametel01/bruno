import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata } from "next";
import { AuthConfigurationUnavailable } from "@/app/_components/auth-configuration-unavailable";
import { resolveClerkTransition } from "@/src/auth/clerk-transition";
import "./globals.css";

export const metadata: Metadata = {
  title: "AgentBay",
  description: "Operational control plane scaffold for managed agents.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const transition = resolveClerkTransition(process.env);
  let content = children;

  if (transition.mode === "clerk") {
    content = (
      <ClerkProvider
        publishableKey={transition.publishableKey}
        signInUrl="/sign-in"
        signUpUrl="/sign-up"
      >
        {children}
      </ClerkProvider>
    );
  } else if (transition.mode === "invalid") {
    content = <AuthConfigurationUnavailable />;
  }

  return (
    <html lang="en">
      <body>{content}</body>
    </html>
  );
}
