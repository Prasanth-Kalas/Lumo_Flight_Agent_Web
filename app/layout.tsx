/**
 * Minimal root layout. The Flight Agent has no user-facing UI — it's a
 * tool-surface service. Users talk to the shell; the shell talks to us.
 * The single HTML page we serve is the operator status page at `/`.
 */

import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Lumo Flight Agent",
  description: "Flight search, pricing, and booking. Service endpoint only.",
  robots: { index: false, follow: false },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, -apple-system, sans-serif", margin: 0 }}>
        {children}
      </body>
    </html>
  );
}
