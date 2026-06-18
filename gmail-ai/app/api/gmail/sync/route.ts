import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { syncGmailFull, syncGmailIncremental } from '@/lib/gmail';
import { categorizeEmail, embedPassage, summarizeThread } from '@/lib/ai';
import { getThreadContext } from '@/lib/rag';
import { htmlToText } from '@/lib/utils';

// POST /api/gmail/sync
// Body: { userId: string; gmailAccountId?: string; mode: 'full' | 'incremental' }
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { userId, mode = 'incremental' } = body;

    if (!userId) {
      return NextResponse.json({ error: 'userId required' }, { status: 400 });
    }

    // Get gmail accounts for this user
    const { data: accounts, error: accError } = await supabaseAdmin
      .from('gmail_accounts')
      .select('*')
      .eq('user_id', userId);

    if (accError || !accounts?.length) {
      return NextResponse.json({ error: 'No Gmail account connected' }, { status: 400 });
    }

    const account = accounts[0];
    const gmailAccountId = account.id;

    // Step 1: Sync emails
    let synced = 0;
    if (mode === 'full' || !account.history_id) {
      const result = await syncGmailFull(gmailAccountId);
      synced = result.synced;
    } else {
      const result = await syncGmailIncremental(gmailAccountId);
      synced = result.synced;
    }

    // Step 2: Process threads that don't have embeddings/summaries yet
    const { data: unprocessedThreads } = await supabaseAdmin
      .from('email_threads')
      .select('id, subject, participants, labels')
      .eq('gmail_account_id', gmailAccountId)
      .is('embedding', null)
      .order('last_message_date', { ascending: false })
      .limit(50); // process up to 50 threads per sync

    let processed = 0;

    if (unprocessedThreads?.length) {
      // Process in batches of 5 to avoid rate limits
      for (let i = 0; i < unprocessedThreads.length; i += 5) {
        const batch = unprocessedThreads.slice(i, i + 5);

        await Promise.allSettled(
          batch.map(async (thread) => {
            try {
              // Get thread messages text
              const threadText = await getThreadContext(thread.id);
              if (!threadText) return;

              // Get first message for categorization
              const { data: firstMsg } = await supabaseAdmin
                .from('email_messages')
                .select('from_address, subject, body_text, body_html')
                .eq('thread_id', thread.id)
                .order('date', { ascending: true })
                .limit(1)
                .single();

              const bodyText = firstMsg?.body_text ||
                htmlToText(firstMsg?.body_html ?? '').slice(0, 500);

              // Parallel: summarize + categorize + embed
              const [summary, category, embedding] = await Promise.all([
                summarizeThread(threadText).catch(() => null),
                categorizeEmail(
                  thread.subject ?? '',
                  firstMsg?.from_address ?? '',
                  bodyText
                ).catch(() => null),
                embedPassage(`${thread.subject ?? ''}\n${bodyText}`).catch(() => null),
              ]);

              // Update thread with summary + embedding
              await supabaseAdmin
                .from('email_threads')
                .update({
                  summary: summary ?? null,
                  embedding: embedding ?? null,
                })
                .eq('id', thread.id);

              // Store category
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

              processed++;
            } catch (err) {
              console.error(`Error processing thread ${thread.id}:`, err);
            }
          })
        );

        // Small delay between batches
        if (i + 5 < unprocessedThreads.length) {
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    }

    return NextResponse.json({
      success: true,
      synced,
      processed,
      mode,
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
