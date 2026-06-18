import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { summarizeThread, draftReply, draftNewEmail } from '@/lib/ai';
import { getThreadContext } from '@/lib/rag';

// POST /api/summarize
// Body: { threadId?: string; action: 'summarize' | 'draft_reply' | 'draft_compose'; instruction?: string; userEmail?: string }
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { threadId, action = 'summarize', instruction, userEmail } = body;

    // ── draft_compose: compose a brand-new email from a prompt ──
    if (action === 'draft_compose') {
      if (!instruction) {
        return NextResponse.json({ error: 'instruction required for compose' }, { status: 400 });
      }
      const result = await draftNewEmail(instruction, userEmail ?? '');
      return NextResponse.json(result); // { subject, draft }
    }

    // All other actions require a threadId
    if (!threadId) {
      return NextResponse.json({ error: 'threadId required' }, { status: 400 });
    }

    // Fetch full thread conversation text
    const threadText = await getThreadContext(threadId);
    if (!threadText) {
      return NextResponse.json({ error: 'No messages found for thread' }, { status: 404 });
    }

    // ── summarize ────────────────────────────────────────────────
    if (action === 'summarize') {
      // Return cached summary if it exists
      const { data: thread } = await supabaseAdmin
        .from('email_threads')
        .select('summary')
        .eq('id', threadId)
        .single();

      if (thread?.summary) {
        return NextResponse.json({ summary: thread.summary });
      }

      const summary = await summarizeThread(threadText);

      // Cache in DB
      await supabaseAdmin
        .from('email_threads')
        .update({ summary })
        .eq('id', threadId);

      return NextResponse.json({ summary });
    }

    // ── draft_reply: reply to an existing thread ─────────────────
    if (action === 'draft' || action === 'draft_reply') {
      if (!instruction) {
        return NextResponse.json({ error: 'instruction required for draft' }, { status: 400 });
      }
      const draft = await draftReply(threadText, instruction, userEmail ?? '');
      return NextResponse.json({ draft });
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (err) {
    console.error('Summarize error:', err);
    return NextResponse.json(
      { error: 'AI processing failed', details: String(err) },
      { status: 500 }
    );
  }
}

// GET /api/summarize?threadId=... — fetch messages for a thread (server-side, bypasses RLS)
export async function GET(request: NextRequest) {
  try {
    const threadId = request.nextUrl.searchParams.get('threadId');
    if (!threadId) {
      return NextResponse.json({ error: 'threadId required' }, { status: 400 });
    }

    const { data: messages, error } = await supabaseAdmin
      .from('email_messages')
      .select('*')
      .eq('thread_id', threadId)
      .order('date', { ascending: true });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const { data: category } = await supabaseAdmin
      .from('email_categories')
      .select('category, confidence')
      .eq('thread_id', threadId)
      .single();

    return NextResponse.json({ messages: messages ?? [], category: category ?? null });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
