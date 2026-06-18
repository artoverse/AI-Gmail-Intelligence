import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

// ─────────────────────────────────────────────────────────────
// Rule-based fast categorization (no AI, pure string matching)
// Handles ~90% of emails instantly with zero API calls.
// ─────────────────────────────────────────────────────────────
function ruleBasedCategory(
  subject: string,
  fromAddress: string,
  bodySnippet: string
): string {
  const sub = (subject ?? '').toLowerCase();
  const from = (fromAddress ?? '').toLowerCase();
  const body = (bodySnippet ?? '').toLowerCase().slice(0, 300);

  // ── Newsletter ──────────────────────────────────────────────
  if (
    body.includes('unsubscribe') ||
    sub.includes('newsletter') ||
    sub.includes('digest') ||
    sub.includes('weekly') ||
    sub.includes('monthly') ||
    from.includes('noreply@') ||
    from.includes('no-reply@') ||
    from.includes('donotreply') ||
    from.includes('notifications@') ||
    from.includes('newsletter') ||
    from.includes('marketing') ||
    from.includes('info@') ||
    from.includes('mailchimp') ||
    from.includes('sendgrid') ||
    from.includes('substack') ||
    from.includes('producthunt') ||
    from.includes('udemy') ||
    from.includes('coursera') ||
    from.includes('medium') ||
    from.includes('hackernews') ||
    from.includes('youtube') ||
    from.includes('instagram') ||
    from.includes('twitter') ||
    from.includes('facebook') ||
    from.includes('announce')
  ) return 'Newsletter';

  // ── Job ─────────────────────────────────────────────────────
  if (
    from.includes('linkedin') ||
    from.includes('indeed') ||
    from.includes('glassdoor') ||
    from.includes('naukri') ||
    from.includes('monster') ||
    from.includes('careers@') ||
    from.includes('jobs@') ||
    from.includes('recruit') ||
    from.includes('talent') ||
    from.includes('hiring') ||
    sub.includes('job opportunity') ||
    sub.includes('job application') ||
    sub.includes('new job') ||
    sub.includes('interview') ||
    sub.includes('offer letter') ||
    sub.includes('resume') ||
    sub.includes('salary') ||
    sub.includes('position')
  ) return 'Job';

  // ── Finance ─────────────────────────────────────────────────
  if (
    sub.includes('payment') ||
    sub.includes('invoice') ||
    sub.includes('receipt') ||
    sub.includes('transaction') ||
    sub.includes('statement') ||
    sub.includes('bank') ||
    sub.includes('transfer') ||
    sub.includes('refund') ||
    sub.includes('bill') ||
    sub.includes('due') ||
    from.includes('stripe') ||
    from.includes('paypal') ||
    from.includes('razorpay') ||
    from.includes('hdfc') ||
    from.includes('sbi') ||
    from.includes('icici') ||
    from.includes('axis') ||
    from.includes('billing@') ||
    from.includes('payments@') ||
    from.includes('accounts@') ||
    from.includes('noreply@paypal') ||
    body.includes('amount due') ||
    body.includes('your payment') ||
    body.includes('total amount')
  ) return 'Finance';

  // ── Notification ────────────────────────────────────────────
  if (
    from.includes('github') ||
    from.includes('gitlab') ||
    from.includes('jira') ||
    from.includes('slack') ||
    from.includes('google') ||
    from.includes('apple') ||
    from.includes('microsoft') ||
    from.includes('amazon') ||
    from.includes('render') ||
    from.includes('vercel') ||
    from.includes('aws') ||
    from.includes('security@') ||
    from.includes('alerts@') ||
    from.includes('support@') ||
    from.includes('help@') ||
    from.includes('system@') ||
    sub.includes('verify') ||
    sub.includes('verification') ||
    sub.includes('confirm') ||
    sub.includes('alert') ||
    sub.includes('security') ||
    sub.includes('login') ||
    sub.includes('password') ||
    sub.includes('otp') ||
    sub.includes('sign in') ||
    sub.includes('2-step') ||
    sub.includes('build failed') ||
    sub.includes('deploy') ||
    sub.includes('error') ||
    sub.includes('warning') ||
    sub.includes('notification')
  ) return 'Notification';

  // ── Work ────────────────────────────────────────────────────
  if (
    sub.includes('meeting') ||
    sub.includes('project') ||
    sub.includes('report') ||
    sub.includes('proposal') ||
    sub.includes('agenda') ||
    sub.includes('review') ||
    sub.includes('deadline') ||
    sub.includes('contract') ||
    sub.includes('task') ||
    sub.includes('team') ||
    sub.includes('client') ||
    body.includes('dear team') ||
    body.includes('best regards') ||
    body.includes('kind regards') ||
    body.includes('please find')
  ) return 'Work';

  // ── Personal ────────────────────────────────────────────────
  if (
    sub.includes('hi ') ||
    sub.startsWith('re:') ||
    sub.startsWith('fwd:') ||
    body.includes('hey ') ||
    body.includes('hope you') ||
    body.includes('how are you')
  ) return 'Personal';

  // Default: Other
  return 'Other';
}

const BATCH_SIZE = 50;

// POST /api/gmail/categorize
// Body: { userId: string; page?: number }
// Processes ONE batch of 50 threads. Client calls repeatedly with page++ until done=true.
export async function POST(request: NextRequest) {
  const startTime = Date.now();

  try {
    const body = await request.json();
    const { userId, page = 0 } = body;
    if (!userId) return NextResponse.json({ error: 'userId required' }, { status: 400 });

    // Get gmail account
    const { data: account } = await supabaseAdmin
      .from('gmail_accounts')
      .select('id')
      .eq('user_id', userId)
      .single();

    if (!account) return NextResponse.json({ error: 'No Gmail account', done: true }, { status: 404 });

    const gmailAccountId = account.id;

    // ── Step 1: Get 50 thread IDs at this page (tiny query) ──
    const { data: threads, error: threadErr } = await supabaseAdmin
      .from('email_threads')
      .select('id, subject')
      .eq('gmail_account_id', gmailAccountId)
      .order('last_message_date', { ascending: false })
      .range(page * BATCH_SIZE, (page + 1) * BATCH_SIZE - 1);

    if (threadErr) throw threadErr;
    if (!threads?.length) {
      return NextResponse.json({ success: true, done: true, categorized: 0, page });
    }

    const threadIds = threads.map((t) => t.id);

    // ── Step 2: Find which are already categorized (small .in() of 50) ──
    const { data: existing } = await supabaseAdmin
      .from('email_categories')
      .select('thread_id')
      .in('thread_id', threadIds);

    const doneSet = new Set((existing ?? []).map((e) => e.thread_id));
    const todo = threads.filter((t) => !doneSet.has(t.id));

    if (todo.length === 0) {
      // All in this page already categorized — advance
      return NextResponse.json({
        success: true,
        done: threads.length < BATCH_SIZE,
        categorized: 0,
        skipped: BATCH_SIZE,
        page,
      });
    }

    // ── Step 3: Get first message for each todo thread (batch query) ──
    const todoIds = todo.map((t) => t.id);
    const { data: messages } = await supabaseAdmin
      .from('email_messages')
      .select('thread_id, from_address, body_text')
      .in('thread_id', todoIds)
      .order('date', { ascending: true });

    // First message per thread
    const msgByThread = new Map<string, { from_address: string; body_text: string }>();
    for (const msg of messages ?? []) {
      if (!msgByThread.has(msg.thread_id)) msgByThread.set(msg.thread_id, msg);
    }

    // ── Step 4: Rule-based categorize (instant, no API calls) ──
    const toUpsert = todo.map((thread) => {
      const msg = msgByThread.get(thread.id);
      const category = ruleBasedCategory(
        thread.subject ?? '',
        msg?.from_address ?? '',
        msg?.body_text ?? ''
      );
      return { thread_id: thread.id, category, confidence: category === 'Other' ? 0.5 : 0.85 };
    });

    // ── Step 5: BULK upsert — ONE DB call for all 50 rows ──────
    const { error: upsertErr } = await supabaseAdmin
      .from('email_categories')
      .upsert(toUpsert, { onConflict: 'thread_id' });

    if (upsertErr) throw upsertErr;

    return NextResponse.json({
      success: true,
      done: threads.length < BATCH_SIZE, // true when last page
      categorized: toUpsert.length,
      page,
      elapsed: Math.round((Date.now() - startTime) / 1000) + 's',
    });
  } catch (err) {
    console.error('Categorize error:', err);
    return NextResponse.json({ error: String(err), done: false }, { status: 500 });
  }
}

// GET /api/gmail/categorize?userId=...  — categorization progress
export async function GET(request: NextRequest) {
  const userId = request.nextUrl.searchParams.get('userId');
  if (!userId) return NextResponse.json({ error: 'userId required' }, { status: 400 });

  const { data: account } = await supabaseAdmin
    .from('gmail_accounts')
    .select('id')
    .eq('user_id', userId)
    .single();

  if (!account) return NextResponse.json({ total: 0, categorized: 0, remaining: 0 });

  // Count total threads for this account
  const { count: total } = await supabaseAdmin
    .from('email_threads')
    .select('id', { count: 'exact', head: true })
    .eq('gmail_account_id', account.id);

  // Count categorized threads using inner join (avoids .in() with 1000+ IDs)
  const { count: categorized } = await supabaseAdmin
    .from('email_threads')
    .select('email_categories!inner(thread_id)', { count: 'exact', head: true })
    .eq('gmail_account_id', account.id);

  return NextResponse.json({
    total: total ?? 0,
    categorized: categorized ?? 0,
    remaining: (total ?? 0) - (categorized ?? 0),
  });
}
