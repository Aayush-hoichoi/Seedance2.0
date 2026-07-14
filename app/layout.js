import './globals.css';
import { Bricolage_Grotesque, Hanken_Grotesk, JetBrains_Mono } from "next/font/google";
import { ClerkProvider } from '@clerk/nextjs';

// 2 + 1 type system (see design.md): display / body / mono.
const display = Bricolage_Grotesque({ subsets: ["latin"], variable: "--font-display", display: "swap" });
const body = Hanken_Grotesk({ subsets: ["latin"], variable: "--font-body", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });

export const metadata = {
  title: 'Open Generative AI — Free AI Image & Video Studio',
  description: 'Generate AI images and videos using 200+ models — Flux, Midjourney, Kling, Veo, Seedance and more.',
};

export default function RootLayout({ children }) {
  return (
    <ClerkProvider afterSignOutUrl="/sign-in">
      <html lang="en">
        <body className={`${display.variable} ${body.variable} ${mono.variable}`}>
          {/* Apply the saved accent theme before first paint (no flash of the
              default violet). Mirrors lib/theme/themeClient.js applyThemeVars. */}
          <script
            dangerouslySetInnerHTML={{
              __html: `try{var t=JSON.parse(localStorage.getItem('seedance:theme'));if(t&&t.accent){var s=document.documentElement.style;s.setProperty('--accent',t.accent);s.setProperty('--accent-hi',t.accentHi);s.setProperty('--accent-ink',t.accentInk);}}catch(e){}`,
            }}
          />
          {children}
        </body>
      </html>
    </ClerkProvider>
  );
}
