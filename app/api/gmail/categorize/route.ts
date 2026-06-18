import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

// ─────────────────────────────────────────────────────────────
// Rule-based categorization — ordered MOST SPECIFIC → LEAST SPECIFIC
//
// ORDER MATTERS: each block exits early on first match.
// Finance / Job / Notification come BEFORE Newsletter to prevent
// bank emails, OTPs, and GitHub alerts from being mislabeled.
// ─────────────────────────────────────────────────────────────
function ruleBasedCategory(
  subject: string,
  fromAddress: string,
  bodySnippet: string
): string {
  const sub  = (subject     ?? '').toLowerCase().trim();
  const from = (fromAddress ?? '').toLowerCase();
  const body = (bodySnippet ?? '').toLowerCase().slice(0, 600);

  // ── 1. FINANCE — payment processors, banks, invoices ─────────
  if (
    from.includes('stripe.com')         ||
    from.includes('paypal.com')         ||
    from.includes('razorpay.com')       ||
    from.includes('paytm')              ||
    from.includes('hdfc')               ||
    from.includes('icici')              ||
    from.includes('sbi.')               ||
    from.includes('axisbank')           ||
    from.includes('kotak')              ||
    from.includes('billing@')           ||
    from.includes('payments@')          ||
    from.includes('invoice@')           ||
    from.includes('accounts@')          ||
    from.includes('finance@')           ||
    sub.includes('invoice')             ||
    sub.includes('receipt')             ||
    sub.includes('payment received')    ||
    sub.includes('payment failed')      ||
    sub.includes('payment confirmation') ||
    sub.includes('transaction')         ||
    sub.includes('bank statement')      ||
    sub.includes('refund')              ||
    sub.includes('your order')          ||
    body.includes('amount due')         ||
    body.includes('total amount')       ||
    body.includes('your payment of')    ||
    body.includes('charged to your')    ||
    body.includes('invoice number')     ||
    body.includes('receipt number')
  ) return 'Finance';

  // ── 2. JOB — job boards, recruiters, applications ────────────
  if (
    from.includes('linkedin.com')       ||
    from.includes('indeed.com')         ||
    from.includes('glassdoor.com')      ||
    from.includes('naukri.com')         ||
    from.includes('monster.com')        ||
    from.includes('ziprecruiter')       ||
    from.includes('careers@')           ||
    from.includes('jobs@')              ||
    from.includes('talent@')            ||
    from.includes('recruiting@')        ||
    from.includes('hr@')                ||
    from.includes('recruitment')        ||
    sub.includes('interview')           ||
    sub.includes('job opportunity')     ||
    sub.includes('job offer')           ||
    sub.includes('job application')     ||
    sub.includes('offer letter')        ||
    sub.includes('application received') ||
    sub.includes('thank you for applying') ||
    sub.includes('your application')    ||
    sub.includes('internship')          ||
    sub.includes('shortlisted')         ||
    sub.includes('hiring')              ||
    body.includes('years of experience') ||
    body.includes('job description')    ||
    body.includes('we reviewed your application')
  ) return 'Job';

  // ── 3. NOTIFICATION — system alerts, OTP, security, deploys ──
  // noreply@ / no-reply@ belongs here, NOT Newsletter
  if (
    from.includes('github.com')         ||
    from.includes('gitlab.com')         ||
    from.includes('jira')               ||
    from.includes('atlassian.com')      ||
    from.includes('slack.com')          ||
    from.includes('google.com')         ||
    from.includes('accounts.google')    ||
    from.includes('apple.com')          ||
    from.includes('microsoft.com')      ||
    from.includes('amazonses.com')      ||
    from.includes('amazon.com')         ||
    from.includes('render.com')         ||
    from.includes('vercel.com')         ||
    from.includes('netlify.com')        ||
    from.includes('heroku.com')         ||
    from.includes('awsnotif')           ||
    from.includes('security@')          ||
    from.includes('alerts@')            ||
    from.includes('alert@')             ||
    from.includes('noreply@')           ||
    from.includes('no-reply@')          ||
    from.includes('donotreply')         ||
    from.includes('notifications@')     ||
    from.includes('notification@')      ||
    from.includes('support@')           ||
    from.includes('help@')              ||
    sub.includes('verify your')         ||
    sub.includes('verify email')        ||
    sub.includes('confirm your')        ||
    sub.includes('email confirmation')  ||
    sub.includes('otp')                 ||
    sub.includes('one-time')            ||
    sub.includes('security alert')      ||
    sub.includes('security code')       ||
    sub.includes('sign-in attempt')     ||
    sub.includes('login attempt')       ||
    sub.includes('new login')           ||
    sub.includes('password reset')      ||
    sub.includes('reset your password') ||
    sub.includes('2-step')              ||
    sub.includes('two-factor')          ||
    sub.includes('build failed')        ||
    sub.includes('build passed')        ||
    sub.includes('deployment')          ||
    sub.includes('deploy')              ||
    sub.includes('pull request')        ||
    sub.includes('merged')              ||
    sub.includes('new issue')           ||
    body.includes('one-time password')  ||
    body.includes('verification code')  ||
    body.includes('your otp is')
  ) return 'Notification';

  // ── 4. WORK — professional business communication ─────────────
  if (
    sub.includes('meeting')             ||
    sub.includes('agenda')              ||
    sub.includes('minutes of')          ||
    sub.includes('project update')      ||
    sub.includes('project status')      ||
    sub.includes('deadline')            ||
    sub.includes('deliverable')         ||
    sub.includes('proposal')            ||
    sub.includes('quotation')           ||
    sub.includes('contract')            ||
    sub.includes('agreement')           ||
    sub.includes('follow up')           ||
    sub.includes('action required')     ||
    sub.includes('action items')        ||
    sub.includes('status update')       ||
    body.includes('dear team')          ||
    body.includes('as discussed')       ||
    body.includes('please find attached') ||
    body.includes('kind regards')       ||
    body.includes('best regards')       ||
    body.includes('looking forward to our')
  ) return 'Work';

  // ── 5. PERSONAL — direct human-to-human conversation ─────────
  if (
    sub.startsWith('re: ')              ||
    sub.startsWith('re:')               ||
    sub.startsWith('fwd: ')             ||
    sub.startsWith('fwd:')              ||
    body.startsWith('hi ')              ||
    body.startsWith('hey ')             ||
    body.startsWith('dear ')            ||
    body.includes('hope you are doing') ||
    body.includes('how are you')        ||
    body.includes('hope this finds you') ||
    body.includes('just wanted to')
  ) return 'Personal';

  // ── 6. NEWSLETTER — subscription content, digests ────────────
  // Checked LAST among specific categories.
  // Primary signal: unsubscribe / opt-out link in the body.
  if (
    body.includes('unsubscribe')        ||
    body.includes('opt out')            ||
    body.includes('manage preferences') ||
    body.includes('manage subscription') ||
    body.includes('view in browser')    ||
    from.includes('mailchimp')          ||
    from.includes('substack.com')       ||
    from.includes('beehiiv.com')        ||
    from.includes('convertkit.com')     ||
    from.includes('campaign-archive')   ||
    from.includes('producthunt.com')    ||
    from.includes('medium.com')         ||
    from.includes('hackernews')         ||
    from.includes('udemy.com')          ||
    from.includes('coursera.org')       ||
    from.includes('pluralsight')        ||
    from.includes('dev.to')             ||
    from.includes('hashnode')           ||
    from.includes('newsletter')         ||
    from.includes('marketing@')         ||
    from.includes('news@')              ||
    sub.includes('newsletter')          ||
    sub.includes('digest')              ||
    sub.includes('this week in')        ||
    sub.includes('weekly roundup')      ||
    sub.includes('weekly update')       ||
    sub.includes('top stories')         ||
    sub.includes('issue #')             ||
    sub.includes('vol.')
  ) return 'Newsletter';

  // ── 7. DEFAULT ────────────────────────────────────────────────
  return 'Other';
}

const BATCH_SIZE = 50;

// POST /api/gmail/categorize
// Body: { userId: string; page?: number; reset?: boolean }
// Processes ONE batch of 50 threads. Client calls repeatedly with page++ until done=true.
// Pass reset=true to re-categorize ALL threads (clears existing categories first).
export async function POST(request: NextRequest) {
  const startTime = Date.now();

  try {
    const body = await request.json();
    const { userId, page = 0, reset = false } = body;
    if (!userId) return NextResponse.json({ error: 'userId required' }, { status: 400 });

    // Get gmail account
    const { data: account } = await supabaseAdmin
      .from('gmail_accounts')
      .select('id')
      .eq('user_id', userId)
      .single();

    if (!account) return NextResponse.json({ error: 'No Gmail account', done: true }, { status: 404 });

    const gmailAccountId = account.id;

    // If reset=true on page 0, delete all existing categories for a fresh run
    if (reset && page === 0) {
      const { data: allThreadIds } = await supabaseAdmin
        .from('email_threads')
        .select('id')
        .eq('gmail_account_id', gmailAccountId);

      if (allThreadIds?.length) {
        // Delete in chunks of 100 to avoid large .in() calls
        for (let i = 0; i < allThreadIds.length; i += 100) {
          const chunk = allThreadIds.slice(i, i + 100).map(t => t.id);
          await supabaseAdmin.from('email_categories').delete().in('thread_id', chunk);
        }
      }
    }

    // ── Step 1: Get 50 threads at this page ──────────────────────
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

    // ── Step 2: Find which are already categorized ────────────────
    const { data: existing } = await supabaseAdmin
      .from('email_categories')
      .select('thread_id')
      .in('thread_id', threadIds);

    const doneSet = new Set((existing ?? []).map((e) => e.thread_id));
    const todo = threads.filter((t) => !doneSet.has(t.id));

    if (todo.length === 0) {
      return NextResponse.json({
        success: true,
        done: threads.length < BATCH_SIZE,
        categorized: 0,
        skipped: BATCH_SIZE,
        page,
      });
    }

    // ── Step 3: Batch-fetch first message per uncategorized thread ─
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

    // ── Step 4: Apply rules ───────────────────────────────────────
    const toInsert = todo.map((thread) => {
      const msg = msgByThread.get(thread.id);
      const category = ruleBasedCategory(
        thread.subject ?? '',
        msg?.from_address ?? '',
        msg?.body_text ?? ''
      );
      return { thread_id: thread.id, category, confidence: category === 'Other' ? 0.5 : 0.85 };
    });

    // ── Step 5: DELETE any stale rows, then bulk INSERT ───────────
    // (thread_id has no UNIQUE constraint in the deployed DB, so
    //  DELETE+INSERT is more reliable than upsert)
    if (todoIds.length > 0) {
      await supabaseAdmin.from('email_categories').delete().in('thread_id', todoIds);
    }

    const { error: insertErr } = await supabaseAdmin
      .from('email_categories')
      .insert(toInsert);

    if (insertErr) {
      console.error('Insert error:', insertErr.message, insertErr.details);
      return NextResponse.json({ error: insertErr.message, done: false, page }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      done: threads.length < BATCH_SIZE,
      categorized: toInsert.length,
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
