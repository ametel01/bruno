import type { Metadata } from "next";
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
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
