import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { categorizeEmail } from '@/lib/ai';

// ─── Rule-based fast categorization (no AI, instant) ───────────────
// Handles the majority of emails without any API calls
function ruleBasedCategory(
  subject: string,
  fromAddress: string,
  bodySnippet: string
): string | null {
  const sub = (subject ?? '').toLowerCase();
  const from = (fromAddress ?? '').toLowerCase();
  const body = (bodySnippet ?? '').toLowerCase();
  const all = `${sub} ${from} ${body}`;

  // Newsletter patterns
  if (
    all.includes('unsubscribe') ||
    all.includes('newsletter') ||
    all.includes('digest') ||
    from.includes('noreply@') ||
    from.includes('no-reply@') ||
    from.includes('donotreply') ||
    from.includes('notifications@') ||
    from.includes('mailchimp') ||
    from.includes('sendgrid') ||
    from.includes('substack') ||
    from.includes('marketing') ||
    all.includes('view in browser') ||
    all.includes('email preferences') ||
    all.includes('manage your subscriptions') ||
    from.includes('udemy') ||
    from.includes('coursera') ||
    from.includes('medium') ||
    from.includes('producthunt') ||
    from.includes('hacker news')
  ) {
    return 'Newsletter';
  }

  // Job patterns
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
    sub.includes('job opportunity') ||
    sub.includes('job application') ||
    sub.includes('we found a job') ||
    sub.includes('new job') ||
    sub.includes('hiring') ||
    sub.includes('interview') ||
    sub.includes('offer letter')
  ) {
    return 'Job';
  }

  // Finance patterns
  if (
    sub.includes('payment') ||
    sub.includes('invoice') ||
    sub.includes('receipt') ||
    sub.includes('transaction') ||
    sub.includes('statement') ||
    sub.includes('bank') ||
    sub.includes('transfer') ||
    sub.includes('refund') ||
    from.includes('stripe') ||
    from.includes('paypal') ||
    from.includes('razorpay') ||
    from.includes('hdfc') ||
    from.includes('sbi') ||
    from.includes('icici') ||
    from.includes('billing@') ||
    from.includes('payments@') ||
    from.includes('accounts@') ||
    sub.includes('₹') ||
    sub.includes('usd') ||
    body.includes('amount due') ||
    body.includes('your payment')
  ) {
    return 'Finance';
  }

  // Notification / System patterns
  if (
    from.includes('github') ||
    from.includes('gitlab') ||
    from.includes('jira') ||
    from.includes('slack') ||
    from.includes('google') ||
    sub.includes('verify') ||
    sub.includes('verification') ||
    sub.includes('confirm') ||
    sub.includes('alert') ||
    sub.includes('security') ||
    sub.includes('login') ||
    sub.includes('password') ||
    sub.includes('otp') ||
    sub.includes('code') ||
    sub.includes('sign in') ||
    sub.includes('account') ||
    from.includes('security@') ||
    from.includes('alerts@') ||
    from.includes('support@') ||
    from.includes('help@') ||
    from.includes('render') ||
    all.includes('build failed') ||
    all.includes('deploy')
  ) {
    return 'Notification';
  }

  // Work patterns
  if (
    sub.includes('meeting') ||
    sub.includes('project') ||
    sub.includes('report') ||
    sub.includes('proposal') ||
    sub.includes('agenda') ||
    sub.includes('review') ||
    sub.includes('update') ||
    sub.includes('deadline') ||
    sub.includes('contract') ||
    body.includes('dear team') ||
    body.includes('best regards') ||
    body.includes('kind regards')
  ) {
    return 'Work';
  }

  return null; // unknown — needs LLM
}

// POST /api/gmail/categorize
// Body: { userId: string }
// Categorizes ALL uncategorized threads. Uses rules first, LLM for remainder.
export async function POST(request: NextRequest) {
  const startTime = Date.now();

  try {
    const { userId } = await request.json();
    if (!userId) return NextResponse.json({ error: 'userId required' }, { status: 400 });

    // Get gmail account
    const { data: account } = await supabaseAdmin
      .from('gmail_accounts')
      .select('id')
      .eq('user_id', userId)
      .single();

    if (!account) {
      return NextResponse.json({ error: 'No Gmail account found' }, { status: 404 });
    }

    const gmailAccountId = account.id;

    // Get ALL threads without a category (join to find missing ones)
    const { data: allThreads } = await supabaseAdmin
      .from('email_threads')
      .select(`
        id, subject,
        email_categories(category),
        email_messages(from_address, body_text, body_html)
      `)
      .eq('gmail_account_id', gmailAccountId)
      .order('last_message_date', { ascending: false });

    if (!allThreads?.length) {
      return NextResponse.json({ success: true, categorized: 0, message: 'No threads to categorize' });
    }

    // Split into: already categorized and uncategorized
    const uncategorized = allThreads.filter((t) => {
      const cats = (t as any).email_categories;
      return !cats || cats.length === 0;
    });

    let ruleCategorized = 0;
    let llmCategorized = 0;
    const needsLLM: typeof uncategorized = [];

    // ── Phase 1: Rule-based categorization (instant, all at once) ──
    for (const thread of uncategorized) {
      const msgs = (thread as any).email_messages ?? [];
      const firstMsg = msgs[0];
      if (!firstMsg) continue;

      const bodyText = (firstMsg.body_text || '').slice(0, 500);
      const category = ruleBasedCategory(
        thread.subject ?? '',
        firstMsg.from_address ?? '',
        bodyText
      );

      if (category) {
        await supabaseAdmin.from('email_categories').upsert(
          { thread_id: thread.id, category, confidence: 0.85 },
          { onConflict: 'thread_id' }
        );
        ruleCategorized++;
      } else {
        needsLLM.push(thread);
      }
    }

    // ── Phase 2: LLM categorization for ambiguous threads ──────────
    // Time-boxed to 22s so we stay within Render's 30s limit
    const LLM_BUDGET_MS = 22_000;

    for (const thread of needsLLM.slice(0, 30)) {
      if (Date.now() - startTime > LLM_BUDGET_MS) break;

      const msgs = (thread as any).email_messages ?? [];
      const firstMsg = msgs[0];
      if (!firstMsg) { needsLLM.push(thread); continue; }

      const bodyText = (firstMsg.body_text || '').slice(0, 400);

      try {
        const result = await categorizeEmail(
          thread.subject ?? '',
          firstMsg.from_address ?? '',
          bodyText
        );
        if (result?.category) {
          await supabaseAdmin.from('email_categories').upsert(
            { thread_id: thread.id, category: result.category, confidence: result.confidence },
            { onConflict: 'thread_id' }
          );
          llmCategorized++;
        }
      } catch (err) {
        console.error('LLM categorize failed for', thread.id, err);
      }
    }

    const remaining = uncategorized.length - ruleCategorized - llmCategorized;

    return NextResponse.json({
      success: true,
      total: allThreads.length,
      uncategorized: uncategorized.length,
      ruleCategorized,
      llmCategorized,
      remaining: Math.max(0, remaining),
      elapsed: Math.round((Date.now() - startTime) / 1000) + 's',
    });
  } catch (err) {
    console.error('Categorize error:', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

// GET /api/gmail/categorize?userId=... — get categorization progress
export async function GET(request: NextRequest) {
  const userId = request.nextUrl.searchParams.get('userId');
  if (!userId) return NextResponse.json({ error: 'userId required' }, { status: 400 });

  const { data: account } = await supabaseAdmin
    .from('gmail_accounts')
    .select('id')
    .eq('user_id', userId)
    .single();

  if (!account) return NextResponse.json({ connected: false });

  const { count: totalThreads } = await supabaseAdmin
    .from('email_threads')
    .select('id', { count: 'exact', head: true })
    .eq('gmail_account_id', account.id);

  const { count: categorizedCount } = await supabaseAdmin
    .from('email_categories')
    .select('thread_id', { count: 'exact', head: true })
    .in(
      'thread_id',
      (await supabaseAdmin
        .from('email_threads')
        .select('id')
        .eq('gmail_account_id', account.id)).data?.map((t) => t.id) ?? []
    );

  return NextResponse.json({
    total: totalThreads ?? 0,
    categorized: categorizedCount ?? 0,
    remaining: (totalThreads ?? 0) - (categorizedCount ?? 0),
  });
}
