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
  const searchTerms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2)
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

export async function hybridSearch(
  query: string,
  gmailAccountId?: string
): Promise<RetrievedThread[]> {
  // Safety guard: never search across all accounts (prevents cross-user data leaks)
  if (!gmailAccountId) return [];

  // Always fetch the 5 most recent threads to ground the assistant in current reality
  // (new emails won't have embeddings yet, so vector search misses them)
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
  gmailAccountId?: string
): AsyncGenerator<string> {
  // 1. Retrieve relevant threads
  const relevantThreads = await hybridSearch(query, gmailAccountId);

  // 1.5 Fetch actual messages for the top 3 threads to ensure the assistant has real content, not just empty summaries
  const topThreads = relevantThreads.slice(0, 3);
  for (const thread of topThreads) {
    const threadContent = await getThreadContext(thread.id);
    // Attach the actual content to the thread object (we'll modify ai.ts to read this)
    (thread as any).content = threadContent;
  }

  // 2. Yield source metadata first as a special token
  const sourcesJson = JSON.stringify(relevantThreads.map((t) => ({
    id: t.id,
    subject: t.subject,
    date: t.last_message_date,
    similarity: t.similarity,
  })));
  yield `__SOURCES__${sourcesJson}__SOURCES_END__`;

  // 3. Stream grounded answer
  // We pass the subset of threads that have been enriched with actual content
  yield* generateGroundedAnswerStream(query, topThreads, chatHistory);
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
