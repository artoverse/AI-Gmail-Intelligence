import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { sendEmail } from '@/lib/gmail';

// POST /api/gmail/send
// Body: { userId, to, subject, body, threadId?, inReplyTo?, references? }
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { userId, to, subject, emailBody, threadId, inReplyTo, references } = body;

    if (!userId || !to || !subject || !emailBody) {
      return NextResponse.json(
        { error: 'userId, to, subject, and emailBody are required' },
        { status: 400 }
      );
    }

    // Get the user's Gmail account
    const { data: account, error } = await supabaseAdmin
      .from('gmail_accounts')
      .select('id')
      .eq('user_id', userId)
      .single();

    if (error || !account) {
      return NextResponse.json({ error: 'No Gmail account connected' }, { status: 400 });
    }

    const messageId = await sendEmail(account.id, {
      to,
      subject,
      body: emailBody,
      threadId,
      inReplyTo,
      references,
    });

    return NextResponse.json({ success: true, messageId });
  } catch (err) {
    console.error('Send email error:', err);
    return NextResponse.json(
      { error: 'Failed to send email', details: String(err) },
      { status: 500 }
    );
  }
}
