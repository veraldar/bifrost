import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import { DiagBoot } from '@/components/diag-boot';
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
    <html lang="en" className={commitMono.variable}>
      <body className="oz">
        <DiagBoot />
        {children}
      </body>
    </html>
  );
}
