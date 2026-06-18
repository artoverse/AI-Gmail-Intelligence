import { NextRequest, NextResponse } from 'next/server';
import { createOAuth2Client } from '@/lib/gmail';
import { supabaseAdmin } from '@/lib/supabase';
import { google } from 'googleapis';

// GET /api/gmail/connect/callback — handles the OAuth code exchange
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const error = searchParams.get('error');
  const appUrl = process.env.NEXT_PUBLIC_APP_URL!;

  if (error || !code) {
    console.error('Gmail OAuth error param:', error);
    return NextResponse.redirect(`${appUrl}/?error=gmail_auth_failed`);
  }

  try {
    // ── Step 1: Exchange code for Gmail tokens ──────────────────
    const oauth2Client = createOAuth2Client();
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // ── Step 2: Get Gmail + Google profile ──────────────────────
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const profile = await gmail.users.getProfile({ userId: 'me' });
    const emailAddress = profile.data.emailAddress!;
    const historyId = profile.data.historyId ?? null;

    // Get the Google email to find matching Supabase user
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const userInfo = await oauth2.userinfo.get();
    const googleEmail = userInfo.data.email!;

    // ── Step 3: Find Supabase user by email ─────────────────────
    // Use listUsers and filter — getUserByEmail doesn't exist in SDK
    let userId: string | null = null;
    let page = 1;
    const perPage = 1000;

    while (!userId) {
      const { data: { users }, error: listError } = await supabaseAdmin.auth.admin.listUsers({
        page,
        perPage,
      });

      if (listError) throw listError;
      if (!users || users.length === 0) break;

      const match = users.find(
        (u) => u.email?.toLowerCase() === googleEmail.toLowerCase()
      );

      if (match) {
        userId = match.id;
        break;
      }

      // If we got fewer than perPage, no more pages
      if (users.length < perPage) break;
      page++;
    }

    if (!userId) {
      console.error('No Supabase user found for email:', googleEmail);
      return NextResponse.redirect(`${appUrl}/?error=user_not_found`);
    }

    // ── Step 4: Upsert gmail_account record ─────────────────────
    const { error: dbError } = await supabaseAdmin
      .from('gmail_accounts')
      .upsert(
        {
          user_id: userId,
          email_address: emailAddress,
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token ?? null,
          token_expiry: tokens.expiry_date
            ? new Date(tokens.expiry_date).toISOString()
            : null,
          history_id: historyId,
          last_synced: null,
        },
        { onConflict: 'email_address' }
      );

    if (dbError) {
      console.error('DB upsert error:', dbError);
      return NextResponse.redirect(`${appUrl}/?error=db_error&detail=${encodeURIComponent(dbError.message)}`);
    }

    return NextResponse.redirect(`${appUrl}/?connected=true`);
  } catch (err) {
    console.error('Gmail connect callback error:', err);
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.redirect(`${appUrl}/?error=oauth_error&detail=${encodeURIComponent(msg)}`);
  }
}
