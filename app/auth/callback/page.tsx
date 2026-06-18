'use client';

import { useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { supabase } from '@/lib/supabase';

/**
 * Supabase PKCE auth callback — runs in the browser.
 *
 * After Google OAuth, Supabase redirects here with ?code=...
 * We exchange the code for a session using the BROWSER-side Supabase client
 * so the session is persisted in localStorage and the rest of the app sees it.
 *
 * A server-side route handler CANNOT persist the session to the browser,
 * which is why we use a client component here instead of route.ts.
 */
export default function AuthCallbackPage() {
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

      // Redirect to the app — session is now stored in browser storage
      router.replace(next);
    };

    handle();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      <svg
        width="24" height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        style={{ animation: 'spin 1s linear infinite' }}
      >
        <path d="M21 12a9 9 0 1 1-6.219-8.56" />
      </svg>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      Signing you in…
    </div>
  );
}
