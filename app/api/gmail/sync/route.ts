import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { syncGmailFull, syncGmailIncremental } from '@/lib/gmail';
import { categorizeEmail, embedPassage } from '@/lib/ai';
import { htmlToText } from '@/lib/utils';

// POST /api/gmail/sync
// Body: { userId: string; mode: 'full' | 'incremental' }
//
// Render free tier has a 30-second request timeout. To avoid timeouts:
// - Phase 1: Sync email messages from Gmail API (fast, just API calls + DB writes)
// - Phase 2: AI categorization runs on ONLY 10 threads max, with a 20s budget check
//   Summaries & embeddings are generated lazily when a thread is opened (see /api/summarize)
export async function POST(request: NextRequest) {
  const startTime = Date.now();

  try {
    const body = await request.json();
    const { userId, mode = 'incremental' } = body;

    if (!userId) {
      return NextResponse.json({ error: 'userId required' }, { status: 400 });
    }

    // Get gmail account for this user
    const { data: accounts, error: accError } = await supabaseAdmin
      .from('gmail_accounts')
      .select('*')
      .eq('user_id', userId);

    if (accError || !accounts?.length) {
      return NextResponse.json({ error: 'No Gmail account connected' }, { status: 400 });
    }

    const account = accounts[0];
    const gmailAccountId = account.id;

    // ── Phase 1: Sync emails from Gmail API ──────────────────────
    // This is the only mandatory phase. Runs fast (parallel batches).
    let synced = 0;
    if (mode === 'full' || !account.history_id) {
      const result = await syncGmailFull(gmailAccountId);
      synced = result.synced;
    } else {
      const result = await syncGmailIncremental(gmailAccountId);
      synced = result.synced;
    }

    // ── Phase 2: AI categorization (time-boxed, best-effort) ─────
    // Only categorize threads that don't have a category yet.
    // We strictly limit to 10 threads and check the clock every thread
    // to stay well within Render's 30s timeout.
    let processed = 0;
    const AI_BUDGET_MS = 20_000; // stop AI work after 20s to leave buffer for response

    try {
      const { data: uncategorized } = await supabaseAdmin
        .from('email_threads')
        .select(`
          id, subject,
          email_categories(category),
          email_messages(from_address, body_text, body_html)
        `)
        .eq('gmail_account_id', gmailAccountId)
        .order('last_message_date', { ascending: false })
        .limit(10); // only 10 — avoids timeout

      if (uncategorized?.length) {
        for (const thread of uncategorized) {
          // Stop if we've used too much time
          if (Date.now() - startTime > AI_BUDGET_MS) break;

          // Skip if already categorized
          const cats = (thread as any).email_categories;
          if (cats?.length > 0) continue;

          const msgs = (thread as any).email_messages ?? [];
          const firstMsg = msgs[0];
          if (!firstMsg) continue;

          const bodyText = (
            firstMsg.body_text ||
            htmlToText(firstMsg.body_html ?? '')
          ).slice(0, 500);

          try {
            const [category, embedding] = await Promise.all([
              categorizeEmail(
                thread.subject ?? '',
                firstMsg.from_address ?? '',
                bodyText
              ).catch(() => null),
              embedPassage(`${thread.subject ?? ''}\n${bodyText}`).catch(() => null),
            ]);

            if (category) {
              await supabaseAdmin.from('email_categories').upsert(
                {
                  thread_id: thread.id,
                  category: category.category,
                  confidence: category.confidence,
                },
                { onConflict: 'thread_id' }
              );
            }

            if (embedding) {
              await supabaseAdmin
                .from('email_threads')
                .update({ embedding })
                .eq('id', thread.id);
            }

            processed++;
          } catch (err) {
            console.error(`AI processing failed for thread ${thread.id}:`, err);
          }
        }
      }
    } catch (aiErr) {
      // AI phase is best-effort — don't fail the whole sync
      console.warn('AI phase skipped due to error:', aiErr);
    }

    return NextResponse.json({
      success: true,
      synced,
      processed,
      mode,
      elapsed: Math.round((Date.now() - startTime) / 1000) + 's',
    });
  } catch (err) {
    console.error('Sync error:', err);
    return NextResponse.json(
      { error: 'Sync failed', details: String(err) },
      { status: 500 }
    );
  }
}

// GET /api/gmail/sync?userId=... — get sync status
export async function GET(request: NextRequest) {
  const userId = request.nextUrl.searchParams.get('userId');
  if (!userId) return NextResponse.json({ error: 'userId required' }, { status: 400 });

  const { data: account } = await supabaseAdmin
    .from('gmail_accounts')
    .select('id, email_address, last_synced, history_id')
    .eq('user_id', userId)
    .single();

  if (!account) {
    return NextResponse.json({ connected: false });
  }

  const { count: threadCount } = await supabaseAdmin
    .from('email_threads')
    .select('id', { count: 'exact', head: true })
    .eq('gmail_account_id', account.id);

  return NextResponse.json({
    connected: true,
    emailAddress: account.email_address,
    lastSynced: account.last_synced,
    threadCount,
  });
}
