import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

export async function GET() {
  try {
    const { data, error } = await supabaseAdmin
      .from('email_messages')
      .select('id, body_text, body_html')
      .limit(3);
    
    if (error) return NextResponse.json({ error: error.message });
    
    return NextResponse.json({
      messages: data.map(m => ({
        id: m.id,
        textLen: m.body_text ? m.body_text.length : 0,
        htmlLen: m.body_html ? m.body_html.length : 0,
        textContent: m.body_text ? m.body_text.slice(0, 100) : null
      }))
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) });
  }
}
