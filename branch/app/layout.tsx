import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import { ThemeProvider } from 'next-themes';
import { DiagBoot } from '@/components/diag-boot';
import { FreshReload } from '@/components/fresh-reload';
import { ThemeColor } from '@/components/theme-color';
import { DOOR_KEY } from '@/lib/tree-first';
import '@/styles/globals.css';

const commitMono = localFont({
  display: 'swap',
  variable: '--font-commit-mono',
  src: [
    { path: '../fonts/CommitMono-400-Regular.otf', weight: '400', style: 'normal' },
    { path: '../fonts/CommitMono-700-Regular.otf', weight: '700', style: 'normal' },
    { path: '../fonts/CommitMono-400-Italic.otf', weight: '400', style: 'italic' },
    { path: '../fonts/CommitMono-700-Italic.otf', weight: '700', style: 'italic' },
  ],
});

export const metadata: Metadata = {
  title: 'Bifrost',
  description: 'Voice & text sessions',
  manifest: '/manifest.json',
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'Bifrost' },
};

export const viewport: Viewport = {
  themeColor: '#080810',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

// before first paint, every page: (1) the old sandbox build left a sticky
// `labmic` key on every device that tapped the tree — the phone sent a lab wav
// instead of its mic (10-14). Cleared here, read by nothing (lib/labmic.ts).
// (2) html[data-door] says whether this device walked the door yet, so the
// server-rendered tree paints at once on a first run and never flashes on a
// returning one (styles/brand.css § door).
const BOOT = `try{localStorage.removeItem('labmic');document.documentElement.dataset.door=localStorage.getItem('${DOOR_KEY}')?'done':'first'}catch(e){document.documentElement.dataset.door='done'}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={commitMono.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: BOOT }} />
      </head>
      <body className="oz">
        <ThemeProvider
          attribute="data-theme"
          themes={['aether', 'terminus', 'drift', 'divergence', 'transcendence', 'control', 'utopia', 'stagnation']}
          defaultTheme="aether"
          // a world flip is one attribute, zero morph: transitions are
          // suppressed for the swap frame
          disableTransitionOnChange
        >
          <ThemeColor />
          <DiagBoot />
          <FreshReload />
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
