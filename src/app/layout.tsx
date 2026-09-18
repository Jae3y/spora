import type { Metadata, Viewport } from 'next';
import { Instrument_Sans, Geist_Mono } from 'next/font/google';
import './globals.css';

/**
 * Typeface pairing.
 *
 * **Instrument Sans** for everything structural. It is a contemporary grotesk
 * with tight, confident spacing and a genuine display weight -- the register
 * Linear, Stripe and Apple's own marketing sit in. Crucially it is a variable
 * font, so the 400-700 range used across this interface ships as one file
 * rather than four.
 *
 * **Geist Mono** for every number. It is retained specifically for its tabular
 * figures: in a financial interface a balance that re-renders every six
 * seconds must not shift horizontally as its digits change, and proportional
 * numerals make exactly that happen.
 *
 * Inter is deliberately not used. It is the default of every AI-generated
 * interface, and the point here is not to look like one.
 */
const displaySans = Instrument_Sans({
  variable: '--font-sans',
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  display: 'swap',
});

const monoNumerals = Geist_Mono({
  variable: '--font-mono',
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Spora · Parametric Climate Escrow',
  description:
    'Cross-continental parametric climate escrow connecting smallholder farmers cooperatives ' +
    'in Kano, Nigeria with biological input exporters in Caranavi, Bolivia. Stellar Soroban, ' +
    'Pollar, Kotani Pay and Open-Meteo satellite telemetry.',
};

/**
 * `themeColor` is pinned to the panel ground rather than left to the browser.
 * On mobile Safari and Android Chrome the status bar otherwise renders white
 * above a near-black page, which reads as a rendering fault.
 */
export const viewport: Viewport = {
  themeColor: '#05141c',
  colorScheme: 'dark',
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="dark">
      <body className={`${displaySans.variable} ${monoNumerals.variable} antialiased`}>
        {children}
      </body>
    </html>
  );
}
