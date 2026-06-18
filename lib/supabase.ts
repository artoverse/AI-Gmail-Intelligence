import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// ─── Browser client (uses anon key, respects RLS) ─────────────
// Lazy singleton to avoid build-time errors when env vars are absent
let _supabase: SupabaseClient | null = null;

export function getSupabase() {
  if (!_supabase) {
    _supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        auth: {
          flowType: 'pkce',
        },
      }
    );
  }
  return _supabase;
}

// Exported as a Proxy so existing `supabase.from(...)` calls still work,
// but the client is only instantiated on first use (not at module parse time)
export const supabase: SupabaseClient = new Proxy({} as SupabaseClient, {
  get(_target, prop) {
    return (getSupabase() as unknown as Record<string | symbol, unknown>)[prop];
  },
});

// ─── Server-side admin client (bypasses RLS) ──────────────────
let _supabaseAdmin: SupabaseClient | null = null;

export function getSupabaseAdmin() {
  if (!_supabaseAdmin) {
    _supabaseAdmin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      }
    );
  }
  return _supabaseAdmin;
}

export const supabaseAdmin: SupabaseClient = new Proxy({} as SupabaseClient, {
  get(_target, prop) {
    return (getSupabaseAdmin() as unknown as Record<string | symbol, unknown>)[prop];
  },
});

// ─── Shared Types ─────────────────────────────────────────────

export type GmailAccount = {
  id: string;
  user_id: string;
  email_address: string | null;
  access_token: string | null;
  refresh_token: string | null;
  token_expiry: string | null;
  history_id: string | null;
  last_synced: string | null;
  created_at: string;
};

export type EmailThread = {
  id: string;
  gmail_account_id: string;
  subject: string | null;
  participants: Array<{ name?: string; email: string }>;
  last_message_date: string | null;
  labels: string[];
  summary: string | null;
  embedding?: number[] | null;
  created_at: string;
  updated_at: string;
  // Joined fields
  category?: string | null;
  confidence?: number | null;
};

export type EmailMessage = {
  id: string;
  thread_id: string;
  from_address: string | null;
  to_addresses: string[];
  cc_addresses: string[];
  date: string | null;
  subject: string | null;
  body_text: string | null;
  body_html: string | null;
  labels: string[];
  raw: Record<string, unknown> | null;
  created_at: string;
};

export type EmailCategory = {
  id: number;
  thread_id: string;
  category: 'Newsletter' | 'Job' | 'Finance' | 'Notification' | 'Personal' | 'Work' | 'Other';
  confidence: number;
  created_at: string;
};
