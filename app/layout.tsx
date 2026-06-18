import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'GmailAI — Intelligent Email Platform',
  description:
    'AI-powered Gmail client with semantic search, automatic categorization, thread summarization, and RAG-based chat. Built with Next.js, Gemini, and NVIDIA NIM.',
  keywords: ['Gmail', 'AI', 'email', 'Gemini', 'RAG', 'semantic search'],
  openGraph: {
    title: 'GmailAI — Intelligent Email Platform',
    description: 'Your inbox, powered by AI.',
    type: 'website',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="antialiased">{children}</body>
    </html>
  );
}
