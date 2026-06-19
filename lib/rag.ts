import { supabaseAdmin } from './supabase';
import { embedText, generateGroundedAnswerStream, type ChatMessage, type RetrievedThread } from './ai';

// ─────────────────────────────────────────────────────────────
// Semantic Search via pgvector
// ─────────────────────────────────────────────────────────────

export async function semanticSearch(
  query: string,
  gmailAccountId?: string,
  options: {
    matchThreshold?: number;
    matchCount?: number;
  } = {}
): Promise<RetrievedThread[]> {
  const { matchThreshold = 0.5, matchCount = 10 } = options;

  try {
    // Embed the user's query
    const queryEmbedding = await embedText(query);

    // Call the match_threads SQL function
    const { data, error } = await supabaseAdmin.rpc('match_threads', {
      query_embedding: queryEmbedding,
      match_threshold: matchThreshold,
      match_count: matchCount,
      account_id: gmailAccountId ?? null,
    });

    if (error) {
      console.error('Vector search error:', error);
      return [];
    }

    return (data ?? []) as RetrievedThread[];
  } catch (err) {
    console.error('Semantic search failed, falling back to keyword:', err);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────
// Keyword fallback search (when no vector results)
// ─────────────────────────────────────────────────────────────

export async function keywordSearch(
  query: string,
  gmailAccountId?: string,
  limit = 8
): Promise<RetrievedThread[]> {
  // Filter out common conversational stop words to find actual meaningful keywords
  const stopWords = new Set(['the', 'what', 'about', 'then', 'how', 'many', 'can', 'you', 'access', 'right', 'now', 'are', 'is', 'a', 'an', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'and', 'or', 'my', 'me', 'i', 'show', 'find', 'get', 'tell', 'about', 'mail', 'email', 'emails', 'message', 'messages', 'this', 'that', 'these', 'those']);
  
  const searchTerms = query
    .toLowerCase()
    .split(/[^a-z0-9.-]+/) // split by non-alphanumeric (keep dots for domains)
    .filter((w) => w.length > 2 && !stopWords.has(w))
    .slice(0, 5);

  try {
    let q = supabaseAdmin
      .from('email_threads')
      .select('id, subject, summary, last_message_date, participants');

    // Filter by account if provided
    if (gmailAccountId) {
      q = q.eq('gmail_account_id', gmailAccountId);
    }

    // Add keyword search if we have terms
    if (searchTerms.length > 0) {
      const orConditions = searchTerms
        .map((term) => `subject.ilike.%${term}%,summary.ilike.%${term}%`)
        .join(',');
      q = q.or(orConditions);
    }

    const { data, error } = await q
      .order('last_message_date', { ascending: false })
      .limit(limit);

    if (error || !data) return [];

    return data.map((t) => ({
      ...t,
      similarity: 0.5,
    })) as RetrievedThread[];
  } catch (err) {
    console.error('Keyword search error:', err);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────
// Recent threads fallback (always returns something)
// ─────────────────────────────────────────────────────────────

export async function recentThreads(
  gmailAccountId?: string,
  limit = 8
): Promise<RetrievedThread[]> {
  try {
    let q = supabaseAdmin
      .from('email_threads')
      .select('id, subject, summary, last_message_date, participants');

    if (gmailAccountId) {
      q = q.eq('gmail_account_id', gmailAccountId);
    }

    const { data, error } = await q
      .order('last_message_date', { ascending: false })
      .limit(limit);

    if (error || !data) return [];

    return data.map((t) => ({
      ...t,
      similarity: 0.4,
    })) as RetrievedThread[];
  } catch (err) {
    console.error('Recent threads error:', err);
    return [];
  }
}

// ─── Recency keywords — skip vector search, just sort by date ────
const RECENCY_TERMS = ['recent', 'latest', 'newest', 'today', 'new', 'last', 'just', 'now'];

function isRecencyQuery(query: string): boolean {
  const lower = query.toLowerCase();
  return RECENCY_TERMS.some((t) => lower.includes(t));
}

// ─── Newsletter queries — fetch newsletter-categorized threads directly ───
function isNewsletterQuery(query: string): boolean {
  return /newsletter|news digest|tech news|what('s| is) new|recent news|top stories|headlines/i.test(query);
}

async function newsletterSearch(gmailAccountId: string, limit = 10): Promise<RetrievedThread[]> {
  // Get thread IDs categorized as Newsletter
  const { data } = await supabaseAdmin
    .from('email_threads')
    .select(`
      id, subject, summary, last_message_date, participants,
      email_categories!inner(category)
    `)
    .eq('gmail_account_id', gmailAccountId)
    .eq('email_categories.category', 'Newsletter')
    .order('last_message_date', { ascending: false })
    .limit(limit);

  return (data ?? []).map(t => ({ ...t, similarity: 0.9 })) as RetrievedThread[];
}

export async function hybridSearch(
  query: string,
  gmailAccountId?: string
): Promise<RetrievedThread[]> {
  // Safety guard: never search across all accounts (prevents cross-user data leaks)
  if (!gmailAccountId) return [];

  // For newsletter/news digest queries — fetch Newsletter-categorized threads directly
  if (isNewsletterQuery(query)) {
    const newsletters = await newsletterSearch(gmailAccountId, 8);
    // Supplement with semantic search results too
    const semantic = await semanticSearch(query, gmailAccountId, { matchThreshold: 0.4, matchCount: 4 });
    const seen = new Set<string>();
    const combined: RetrievedThread[] = [];
    for (const r of [...newsletters, ...semantic]) {
      if (!seen.has(r.id)) { seen.add(r.id); combined.push(r); }
    }
    return combined.slice(0, 10);
  }

  // Always fetch the 5 most recent threads to ground the assistant in current reality
  const recent = await recentThreads(gmailAccountId, 5);

  // For recency-based queries ("what are my recent emails?") just return date-sorted results
  if (isRecencyQuery(query)) {
    return recentThreads(gmailAccountId, 10);
  }

  // Try vector search
  const vectorResults = await semanticSearch(query, gmailAccountId, {
    matchThreshold: 0.45,
    matchCount: 8,
  });

  // Keyword search in parallel
  const keywordResults = await keywordSearch(query, gmailAccountId, 6);

  // Merge: vector first, then keyword, then recent — deduplicated
  const seen = new Set<string>();
  const combined: RetrievedThread[] = [];

  for (const r of [...vectorResults, ...keywordResults, ...recent]) {
    if (!seen.has(r.id)) {
      seen.add(r.id);
      combined.push(r);
    }
  }

  return combined.slice(0, 10);
}

// ─────────────────────────────────────────────────────────────
// Full RAG Chat Pipeline (streaming)
// ─────────────────────────────────────────────────────────────

export async function* chatWithEmails(
  query: string,
  chatHistory: ChatMessage[],
  gmailAccountId?: string,
  inboxMeta?: { totalThreads: number; totalMessages: number }
): AsyncGenerator<string> {
  // 1. Retrieve relevant threads (up to 10)
  const relevantThreads = await hybridSearch(query, gmailAccountId);

  // 2. Fetch actual message content for top 8 threads
  //    (was 3 before — that caused "only 3 emails in context" responses)
  const topThreads = relevantThreads.slice(0, 8);
  await Promise.all(
    topThreads.map(async (thread) => {
      const threadContent = await getThreadContext(thread.id);
      (thread as any).content = threadContent;
    })
  );

  // 3. Yield source metadata first as a special token
  const sourcesJson = JSON.stringify(relevantThreads.map((t) => ({
    id: t.id,
    subject: t.subject,
    date: t.last_message_date,
    similarity: t.similarity,
  })));
  yield `__SOURCES__${sourcesJson}__SOURCES_END__`;

  // 4. Stream grounded answer — pass ALL topThreads (with real content) + inbox meta
  yield* generateGroundedAnswerStream(query, topThreads, chatHistory, inboxMeta);
}

// ─────────────────────────────────────────────────────────────
// Thread messages fetcher for context building
// ─────────────────────────────────────────────────────────────

export async function getThreadContext(threadId: string): Promise<string> {
  const { data: messages, error } = await supabaseAdmin
    .from('email_messages')
    .select('from_address, date, subject, body_text')
    .eq('thread_id', threadId)
    .order('date', { ascending: true })
    .limit(20);

  if (error || !messages?.length) return '';

  return messages
    .map((m) => {
      const date = m.date ? new Date(m.date).toLocaleString() : 'unknown';
      return `--- Message from ${m.from_address} on ${date} ---\n${m.body_text?.slice(0, 4000) ?? ''}`;
    })
    .join('\n\n');
}
