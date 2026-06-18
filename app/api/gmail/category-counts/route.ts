import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const userId = searchParams.get('userId');

  if (!userId) {
    return NextResponse.json({ error: 'Missing userId' }, { status: 400 });
  }

  try {
    // Get the user's gmail_account_id
    const { data: account } = await supabaseAdmin
      .from('gmail_accounts')
      .select('id')
      .eq('user_id', userId)
      .single();

    if (!account) return NextResponse.json({ counts: {} });

    // Fetch all categories for this account to aggregate counts
    const { data, error } = await supabaseAdmin
      .from('email_categories')
      .select(`
        category,
        email_threads!inner(gmail_account_id)
      `)
      .eq('email_threads.gmail_account_id', account.id);

    if (error) {
      console.error('Error fetching category counts:', error);
      return NextResponse.json({ counts: {} });
    }

    // Aggregate counts
    const counts: Record<string, number> = {};
    for (const row of data ?? []) {
      const cat = row.category;
      counts[cat] = (counts[cat] || 0) + 1;
    }

    return NextResponse.json({ counts });
  } catch (error) {
    console.error('Category counts error:', error);
    return NextResponse.json({ counts: {} }, { status: 500 });
  }
}
