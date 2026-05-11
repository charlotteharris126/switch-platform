import type { Metadata } from "next";
import { Geist_Mono, Montserrat } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

// Montserrat is the portal's primary UI font (admin + provider surfaces).
// Loaded with the weights Tailwind expects to use; subset trimmed to latin
// to keep the bundle small. `--font-sans` is what globals.css plugs into
// Tailwind's default `font-sans` family so every existing className gets
// Montserrat without rewriting markup.
const montserrat = Montserrat({
  variable: "--font-sans",
  subsets: ["latin"],
  display: "swap",
  weight: ["400", "500", "600", "700", "800"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Switchable Platform",
  description: "Internal admin and provider portal for Switchable Ltd",
  robots: { index: false, follow: false },
  icons: {
    icon: "/brand/favicon.svg",
    shortcut: "/brand/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${montserrat.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {children}
        <Toaster />
      </body>
    </html>
  );
}
