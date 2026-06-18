'use client';

import { Suspense, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { supabase } from '@/lib/supabase';

// Spinner shown while loading / exchanging code
function Spinner() {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100vh',
      background: '#0a0a0f',
      color: '#a78bfa',
      fontFamily: 'system-ui, sans-serif',
      gap: 12,
    }}>
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" strokeWidth="2"
        style={{ animation: 'spin 1s linear infinite' }}>
        <path d="M21 12a9 9 0 1 1-6.219-8.56" />
      </svg>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      Signing you in…
    </div>
  );
}

// Inner component that reads searchParams — must be inside <Suspense>
function CallbackHandler() {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    const handle = async () => {
      const code = searchParams.get('code');
      const next = searchParams.get('next') ?? '/';

      if (code) {
        const { error } = await supabase.auth.exchangeCodeForSession(code);
        if (error) {
          console.error('Auth callback error:', error.message);
          router.replace(`/?error=${encodeURIComponent(error.message)}`);
          return;
        }
      }

      // Session now stored in browser localStorage — navigate to app
      router.replace(next);
    };

    handle();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <Spinner />;
}

/**
 * Supabase PKCE auth callback page.
 *
 * useSearchParams() requires a Suspense boundary in Next.js App Router,
 * so CallbackHandler is wrapped in <Suspense> below.
 */
export default function AuthCallbackPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <CallbackHandler />
    </Suspense>
  );
}
