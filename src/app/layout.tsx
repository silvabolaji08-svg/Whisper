import type { Metadata, Viewport } from "next";
import { Open_Sans, Poppins } from "next/font/google";

import { THEME_INIT_SCRIPT } from "@/lib/useTheme";
import "./globals.css";

const openSans = Open_Sans({
  variable: "--font-open-sans",
  subsets: ["latin"],
  display: "swap",
});

const poppins = Poppins({
  variable: "--font-poppins",
  weight: ["500", "600", "700"],
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Realtime Chat",
  description: "A realtime chat app built with Next.js and Socket.IO.",
};

export const viewport: Viewport = {
  // Matches the two themes so browser chrome blends with the app background.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f8fc" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0f1c" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      // The theme script sets data-theme before React hydrates.
      suppressHydrationWarning
      className={`${openSans.variable} ${poppins.variable} h-full`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      {/* dvh rather than vh: mobile browser chrome must not push the composer
          below the fold. */}
      <body className="flex min-h-dvh flex-col bg-bg text-fg">{children}</body>
    </html>
  );
}
