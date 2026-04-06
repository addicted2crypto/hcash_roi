import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "hCASH ROI Oracle | Mining Break-Even Calculator",
  description: "The unfiltered truth about hCASH mining ROI. Live marketplace prices, halving-aware break-even analysis, and the fastest path to profit on Avalanche.",
  icons: {
    icon: [
      { url: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>⛏</text></svg>", type: "image/svg+xml" },
    ],
  },
  openGraph: {
    title: "hCASH ROI Oracle",
    description: "Live mining ROI calculator. See the real cost of hCASH mining — live marketplace prices, halving projections, and break-even analysis.",
    siteName: "hCASH ROI Oracle",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "hCASH ROI Oracle",
    description: "The unfiltered truth about hCASH mining ROI. Live data, real math, no BS.",
    creator: "@willisdeving",
  },
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
