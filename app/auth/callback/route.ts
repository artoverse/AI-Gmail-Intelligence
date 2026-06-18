import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// This handles the Supabase Auth callback (code exchange)
export async function GET(request: NextRequest) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get('code');
  const next = requestUrl.searchParams.get('next') ?? '/';

  // Use NEXT_PUBLIC_APP_URL to build the redirect destination.
  // Behind Render's reverse proxy, request.url resolves to
  // http://localhost:10000 (internal port), NOT the public HTTPS URL.
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') ||
    `${requestUrl.protocol}//${requestUrl.host}`;

  if (code) {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        auth: {
          flowType: 'pkce',
          detectSessionInUrl: false,
        },
      }
    );

    await supabase.auth.exchangeCodeForSession(code);
  }

  return NextResponse.redirect(`${appUrl}${next}`);
}
