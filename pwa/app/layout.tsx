import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import { ThemeProvider } from 'next-themes';
import { DiagBoot } from '@/components/diag-boot';
import { FreshReload } from '@/components/fresh-reload';
import { ThemeColor } from '@/components/theme-color';
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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={commitMono.variable} suppressHydrationWarning>
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
