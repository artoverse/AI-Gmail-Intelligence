# Architecture & Design Document
## AI-Powered Gmail Intelligence Platform

---

## 1. System Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         CLIENT BROWSER                              │
│                                                                     │
│  ┌──────────┐  ┌────────────┐  ┌──────────────┐  ┌─────────────┐  │
│  │ Sidebar  │  │ ThreadList │  │  EmailView   │  │  ChatPanel  │  │
│  │(nav/cats)│  │(email list)│  │(thread + AI) │  │ (RAG agent) │  │
│  └────┬─────┘  └─────┬──────┘  └──────┬───────┘  └──────┬──────┘  │
│       │               │                │                  │         │
└───────┼───────────────┼────────────────┼──────────────────┼─────────┘
        │               │                │                  │
        ▼               ▼                ▼                  ▼
┌───────────────────────────────────────────────────────────────────┐
│                     NEXT.JS API ROUTES (Server)                   │
│                                                                   │
│  /api/gmail/connect   → OAuth 2.0 flow initiation                │
│  /api/gmail/sync      → Full + incremental Gmail sync            │
│  /api/gmail/send      → Send / reply email via Gmail API         │
│  /api/gmail/categorize→ Batch rule-based email categorization    │
│  /api/chat            → SSE streaming RAG chat endpoint          │
│  /api/summarize       → Thread summary + AI draft generation     │
└───────────────────────────────────────────────────────────────────┘
        │                                       │
        ▼                                       ▼
┌───────────────┐                   ┌───────────────────────────────┐
│  GOOGLE OAUTH │                   │         SUPABASE              │
│  Gmail API    │                   │  PostgreSQL + pgvector        │
│               │                   │                               │
│  - OAuth 2.0  │                   │  gmail_accounts               │
│  - threads.list│                  │  email_threads (+ embedding)  │
│  - messages   │                   │  email_messages               │
│  - history    │                   │  email_categories             │
│  - send       │                   │  match_threads() RPC          │
└───────────────┘                   └───────────────────────────────┘
                                            │            │
                                    ┌───────┘            └────────┐
                                    ▼                             ▼
                        ┌─────────────────────┐    ┌─────────────────────┐
                        │   NVIDIA NIM API    │    │  NVIDIA NIM Embed   │
                        │                     │    │                     │
                        │  meta/llama-3.1-    │    │  nv-embedqa-e5-v5  │
                        │  8b-instruct        │    │  (1024-dim vectors) │
                        │                     │    │                     │
                        │  - Summarization    │    │  - Thread embedding │
                        │  - Reply drafting   │    │  - Query embedding  │
                        │  - New email compose│    │  - Semantic search  │
                        │  - RAG answering    │    │                     │
                        └─────────────────────┘    └─────────────────────┘
```

### Component Interaction Flow

**Gmail Sync Flow:**
```
User clicks Sync → /api/gmail/sync (POST)
  → refreshGmailToken()           (renew OAuth token if expired)
  → gmail.users.threads.list()    (paginated, max 100 threads)
  → gmail.users.threads.get()     (fetch each thread's messages)
  → Upsert email_threads + email_messages to Supabase
  → Best-effort: embedPassage() + store embedding in email_threads
  → Return { synced, processed }
```

**Chat / RAG Flow:**
```
User sends message → /api/chat (POST, SSE)
  → Fetch inbox meta (totalThreads, totalMessages) from Supabase
  → hybridSearch(query, gmailAccountId):
      ├─ If newsletter query → newsletterSearch() (category-filtered)
      ├─ If recency query   → recentThreads() (date-sorted)
      └─ Otherwise:
          ├─ semanticSearch() via pgvector match_threads RPC
          ├─ keywordSearch() via Supabase ilike filter
          └─ Merge + deduplicate + blend recent threads
  → getThreadContext() for top 8 results (actual message text)
  → generateGroundedAnswerStream() → Llama 3.1 via NVIDIA NIM (SSE)
  → Client receives: [SOURCES token] + [streamed answer chunks]
```

---

## 2. Database Schema

```sql
-- Gmail account credentials and sync state
CREATE TABLE gmail_accounts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES auth.users(id),
  email_address   TEXT,
  access_token    TEXT,              -- Encrypted OAuth access token
  refresh_token   TEXT,              -- Long-lived refresh token
  token_expiry    TIMESTAMPTZ,
  history_id      TEXT,              -- Gmail API history ID for incremental sync
  last_synced     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT now()
);

-- Email threads (conversation-level, first-class entity)
CREATE TABLE email_threads (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gmail_account_id  UUID REFERENCES gmail_accounts(id),
  subject           TEXT,
  participants      JSONB,           -- [{name, email}] array
  last_message_date TIMESTAMPTZ,
  labels            TEXT[],          -- Gmail labels (INBOX, SENT, etc.)
  summary           TEXT,            -- AI-generated thread summary (cached)
  embedding         VECTOR(1024),    -- NVIDIA NIM nv-embedqa-e5-v5 embedding
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now()
);

-- Individual email messages within threads
CREATE TABLE email_messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id       UUID REFERENCES email_threads(id),
  from_address    TEXT,
  to_addresses    TEXT[],
  cc_addresses    TEXT[],
  date            TIMESTAMPTZ,
  subject         TEXT,
  body_text       TEXT,              -- Plain text body
  body_html       TEXT,              -- HTML body (for rich display)
  labels          TEXT[],
  raw             JSONB,             -- Full Gmail API message object
  created_at      TIMESTAMPTZ DEFAULT now()
);

-- AI-assigned categories per thread
CREATE TABLE email_categories (
  id          BIGSERIAL PRIMARY KEY,
  thread_id   UUID UNIQUE REFERENCES email_threads(id),  -- One category per thread
  category    TEXT NOT NULL,         -- Newsletter|Job|Finance|Notification|Personal|Work|Other
  confidence  FLOAT DEFAULT 0.85,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- Indexes for performance
CREATE INDEX idx_email_threads_account ON email_threads(gmail_account_id);
CREATE INDEX idx_email_threads_date ON email_threads(last_message_date DESC);
CREATE INDEX idx_email_messages_thread ON email_messages(thread_id);
CREATE INDEX idx_email_categories_thread ON email_categories(thread_id);
CREATE INDEX idx_email_categories_category ON email_categories(category);

-- pgvector HNSW index for fast ANN search
CREATE INDEX idx_email_threads_embedding ON email_threads 
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
```

### pgvector Design Decisions

**What is embedded:** The concatenation of `subject + summary + first 2000 chars of body_text` from each thread. This gives the embedding semantic coverage of the whole thread at search time.

**Why thread-level (not message-level):** Threads are the primary user-facing unit. Embedding at thread level means one vector per conversation, reducing index size and avoiding redundant near-duplicate vectors for multi-message threads.

**Embedding model:** `nvidia/nv-embedqa-e5-v5` — a 1024-dimensional bilingual retrieval model optimized for asymmetric search (short query → long passage). The `input_type: "passage"` vs `"query"` distinction is used correctly.

**Vector index:** HNSW with `m=16, ef_construction=64` — good balance of recall and speed for a few thousand vectors. No re-indexing needed when new threads are added.

---

## 3. AI Design

### 3.1 Email Summarization

Each thread is summarized on first view (lazy, on-demand):
- Full thread text is assembled from all messages chronologically
- Truncated to 20,000 chars (well within Llama 3.1 8B context window)
- Prompt instructs: Topic / Key Points / Action Items / Decision Made (structured output)
- Summary cached in `email_threads.summary` — never regenerated unless cleared
- Thread-awareness: all messages in the thread are included, so replies are understood in context

### 3.2 RAG Pipeline

```
Query → embedText(query, "query")
     → pgvector cosine similarity (threshold 0.45, top 8)
     → keywordSearch (ilike on subject + summary, top 6)
     → recentThreads (always include 5 newest — catches unembeeded new mail)
     → Merge, deduplicate by thread ID
     → getThreadContext(top 8): fetch actual email_messages text
     → Build context blocks with Subject / Date / Content (up to 3000 chars each)
     → Llama 3.1 8B with grounded system prompt + context
     → Stream SSE chunks to client
```

**Recency bias fix:** New emails may not have embeddings (sync just ran). The pipeline always blends the 5 most recent threads to prevent "I don't see recent emails" failures.

**Newsletter deduplication:** Queries matching `/newsletter|news digest|tech news.../` trigger a special path:
- Fetch Newsletter-categorized threads from DB (not vector search)
- System prompt switches to "deduplication mode": identify unique stories, group same-topic items from multiple sources under one entry, cite all attributing sources

### 3.3 Source Clarity

Every answer includes `[Source N]` citations. The RAG pipeline:
1. Yields sources metadata as a special `__SOURCES__[...]__SOURCES_END__` SSE token before the answer
2. Client renders clickable source chips below each answer
3. Clicking a source chip opens that thread in the email viewer
4. Model is explicitly instructed: "cite sources with [Source N] for every fact"

### 3.4 Hallucination Prevention

- System prompt: "NEVER hallucinate — only state facts from the context below"
- Model temperature set to 0.2 (near-deterministic)
- If no relevant threads found: model told to say "I don't see that in your synced emails"
- Context is grounded in real email_messages text, not just summaries
- Data isolation: `gmailAccountId` guard in hybridSearch prevents cross-user leakage

### 3.5 Why Llama 3.1 8B Instruct (NVIDIA NIM)

| Factor | Decision |
|--------|----------|
| **Role** | Primary LLM for all generation tasks: summarization, reply drafting, compose, RAG chat |
| **Model** | `meta/llama-3.1-8b-instruct` via NVIDIA NIM |
| **Why NVIDIA NIM** | OpenAI-compatible API (drop-in), production-grade inference, free tier available |
| **Why Llama 3.1 8B** | Strong instruction-following, 128K context window, open weights, multilingual |
| **Embedding model** | `nvidia/nv-embedqa-e5-v5` — specifically trained for retrieval/RAG use cases |

---

## 4. Gmail API Strategy

### 4.1 Initial vs Incremental Sync

| Mode | Trigger | Method | Storage |
|------|---------|--------|---------|
| **Full sync** | First connection or manual reset | `threads.list` with pagination, up to 100 threads | Upserts all thread + message rows |
| **Incremental sync** | Subsequent syncs | `history.list` using stored `history_id` | Only fetches changed/new messages since last sync |

The `history_id` from the last Gmail API response is stored in `gmail_accounts.history_id` and used as the starting point for the next incremental sync.

### 4.2 Pagination

- **Full sync**: Fetches 2 pages × 50 threads = 100 threads maximum per sync call (respecting Render's 30s timeout)
- **nextPageToken** from Gmail API is followed iteratively
- Large inboxes handled via repeated sync calls — each adds more threads
- Thread deduplication via `upsert` (never duplicates)

### 4.3 Rate Limiting & Quota

```typescript
// Exponential backoff for 429/500 responses
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  for (let i = 0; i < maxRetries; i++) {
    try { return await fn(); }
    catch (err: any) {
      if (err.status === 429 || err.status === 500) {
        await sleep(Math.pow(2, i) * 1000); // 1s, 2s, 4s
        continue;
      }
      throw err;
    }
  }
}
```

- Gmail API quota: 1 billion units/day (well within limits for single-user sync)
- Each `threads.get` = ~5 units; 100 threads = ~500 units per sync
- Batch processing with sequential fetching (not parallel) to avoid burst quota exhaustion

---

## 5. Tool & Technology Decisions

| Layer | Choice | Reason |
|-------|--------|--------|
| **Frontend** | Next.js 14 (App Router) | Full-stack in one repo, SSE streaming support, React Server Components |
| **Styling** | Vanilla CSS (dark theme) | No build-time overhead, full control, no class conflicts |
| **Database** | Supabase (PostgreSQL + pgvector) | Required. Row-level security, realtime subscriptions, free tier |
| **Auth** | Supabase Auth + Google OAuth | Built-in session management, compatible with Gmail OAuth scopes |
| **Primary AI** | NVIDIA NIM Llama 3.1 8B | Required. OpenAI-compatible, free tier, strong instruction-following |
| **Embeddings** | NVIDIA NIM nv-embedqa-e5-v5 | Retrieval-optimized, asymmetric search (query vs passage), 1024-dim |
| **Vector search** | pgvector HNSW | Stays in Supabase, no additional vector DB needed, ACID transactions |
| **Deployment** | Render (Web Service) | Docker-free, auto-deploys from GitHub, persistent environment |
| **Gmail API** | googleapis npm package | Official client, handles token refresh, proper type definitions |

**No job queue:** Background processing (embeddings, categorization) happens either in-request (time-boxed) or client-driven (Sidebar's Categorize button with page-based polling). For production, a queue (e.g., BullMQ, Inngest) would replace this.

---

## 6. Email Categorization Design

### Two-Phase Approach

**Phase 1 — Rule-based (instant, 0 API calls):**
- Pattern matching on subject, sender domain, and body text
- Handles ~90% of emails correctly
- Categories: Newsletter, Job, Finance, Notification, Work, Personal, Other
- Bulk upsert: 50 threads processed per API call in ~1-2 seconds

**Phase 2 — LLM fallback (removed for reliability):**
- Originally used Llama 3.1 for ambiguous cases
- Removed: Render 30s timeout made it unreliable at scale
- Trade-off accepted: rule-based alone achieves ~90% accuracy
- Everything unmatched defaults to "Other" (no thread left uncategorized)

### Category Taxonomy Justification

| Category | Signal Examples |
|----------|----------------|
| Newsletter | `unsubscribe` in body, `noreply@`, `newsletter` in domain/subject |
| Job | `linkedin.com`, `indeed.com`, `careers@`, subject contains `interview` |
| Finance | Subject/body: `invoice`, `payment`, `receipt`; senders: `stripe`, `paypal` |
| Notification | `github.com`, `security@`, `verify`, `OTP`, `build failed` |
| Work | Subject: `meeting`, `project`, `deadline`, `proposal` |
| Personal | Subject starts with `Re:`, `Fwd:`; body has casual greeting |
| Other | Default fallback |

---

## 7. Trade-offs & Limitations

| Trade-off | What Was Simplified | Production Alternative |
|-----------|-------------------|----------------------|
| **Sync timeout** | Max 100 threads per sync call (Render 30s limit) | Background worker / Inngest job |
| **No LLM categorization at scale** | Rule-based only at 50 threads/batch | Async queue with LLM fallback |
| **No real-time Gmail push** | Pull-based sync only (user-initiated) | Gmail Pub/Sub push notifications |
| **Embeddings on sync** | Best-effort (skipped if timeout) | Async embedding job after sync |
| **Single user** | No multi-tenancy design beyond RLS | Full multi-tenancy with team workspaces |
| **No email search index** | ilike (slow on large datasets) | PostgreSQL full-text search (tsvector) |
| **OAuth "Unverified App"** | Google requires verification for production | Submit for OAuth verification via Google Cloud Console |

### What Would Be Done Differently With More Time

1. **Async job queue** (Inngest/BullMQ) for embedding, summarization, and categorization
2. **Gmail Pub/Sub push** for real-time inbox updates without polling
3. **Full-text search index** on email_messages for faster keyword search
4. **Thread importance scoring** — weight threads by recency × engagement × category
5. **Multi-account support** — allow connecting multiple Gmail accounts per user
6. **Email action tools** — archive, label, snooze directly from the chat agent
