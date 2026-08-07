import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata } from "next";
import { AuthConfigurationUnavailable } from "@/app/_components/auth-configuration-unavailable";
import { resolveAuthMode } from "@/src/auth/server-auth-mode";
import "@xterm/xterm/css/xterm.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "bruno",
  description: "Operational control plane scaffold for managed agents.",
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
      <body>{content}</body>
    </html>
  );
}
