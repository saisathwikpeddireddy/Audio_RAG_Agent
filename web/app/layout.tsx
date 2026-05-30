import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Audio RAG Auto-Editor",
  description: "Upload audio, ask a question, get a stitched highlight reel.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
