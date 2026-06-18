'use client';

import { Suspense, useEffect, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { supabase } from '@/lib/supabase';

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

function CallbackHandler() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const hasRedirected = useRef(false);

  useEffect(() => {
    const next = searchParams.get('next') ?? '/';

    // With implicit flow, the access_token is in the URL hash fragment.
    // Supabase JS auto-detects it and fires TOKEN_REFRESHED or SIGNED_IN.
    // We listen for any event where a valid session exists, then redirect.
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event, session) => {
        // Only redirect once we have a real session
        if (session && !hasRedirected.current) {
          hasRedirected.current = true;
          subscription.unsubscribe();
          // Use window.location for a full page reload to ensure clean state
          window.location.replace(next);
        }
      }
    );

    // Safety: if no session appears within 8 seconds, go home
    const timeout = setTimeout(() => {
      if (!hasRedirected.current) {
        hasRedirected.current = true;
        subscription.unsubscribe();
        window.location.replace('/');
      }
    }, 8000);

    return () => {
      clearTimeout(timeout);
      subscription.unsubscribe();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <Spinner />;
}

export default function AuthCallbackPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <CallbackHandler />
    </Suspense>
  );
}
