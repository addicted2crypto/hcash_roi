import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "hCASH ROI Optimizer",
  description: "Mining ROI calculator for the Club HashCash ecosystem. Live prices, break-even analysis, and whale sensitivity tools.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body style={{ margin: 0, padding: 0, width: '100%', overflowX: 'hidden' }}>{children}</body>
    </html>
  );
}
