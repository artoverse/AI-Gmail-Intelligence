# Architecture & Design Document — AI Gmail Intelligence Platform

## 1. System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        FRONTEND (Next.js 16)                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌───────────────┐   │
│  │ Sidebar   │  │ThreadList│  │EmailView │  │  ChatPanel    │   │
│  │(categories│  │(paginated│  │(iframe   │  │  (streaming   │   │
│  │ filters)  │  │ threads) │  │ reader)  │  │   SSE RAG)    │   │
│  └──────────┘  └──────────┘  └──────────┘  └───────────────┘   │
│  ┌───────────────────────────────────────────────────────────┐   │
│  │               ComposeModal (AI-drafted replies)            │   │
│  └───────────────────────────────────────────────────────────┘   │
└──────────────┬──────────────────────────────────┬───────────────┘
               │                                  │
               ▼                                  ▼
┌──────────────────────────┐     ┌──────────────────────────────┐
│   Next.js API Routes     │     │     Supabase Auth (OAuth)    │
│  ┌────────────────────┐  │     │  Google OAuth 2.0 Provider   │
│  │ /api/chat           │  │     └──────────────────────────────┘
│  │ /api/summarize      │  │
│  │ /api/gmail/connect  │  │
│  │ /api/gmail/sync     │  │
│  │ /api/gmail/send     │  │
│  └────────┬───────────┘  │
└───────────┼──────────────┘
            │
    ┌───────┴───────┐
    ▼               ▼
┌────────────┐ ┌────────────────┐
│ Gmail API  │ │  AI Services   │
│ (OAuth2)   │ │                │
│ - messages │ │ NVIDIA NIM     │
│ - threads  │ │ ├─ Embeddings  │
│ - labels   │ │ │  (nv-embedqa) │
│ - send     │ │ ├─ Chat/RAG    │
│ - history  │ │ │  (Llama 3.1) │
└────────────┘ │ ├─ Summarize   │
               │ ├─ Categorize  │
               │ └─ Draft Reply │
               │                │
               │ Google Gemini  │
               │ └─ Fallback    │
               └───────┬───────┘
                       │
                       ▼
              ┌─────────────────┐
              │    Supabase     │
              │  (PostgreSQL)   │
              │                 │
              │ ┌─────────────┐ │
              │ │gmail_accounts│ │
              │ │email_threads │ │
              │ │email_messages│ │
              │ │email_categories│
              │ │ + pgvector   │ │
              │ └─────────────┘ │
              └─────────────────┘
```

### Request Flow

1. **Authentication**: User signs in via Supabase Auth (Google OAuth). Gmail OAuth is a separate flow through `/api/gmail/connect` for read/write scope.
2. **Sync**: `/api/gmail/sync` fetches messages via Gmail API, extracts bodies, upserts into Supabase. Background processing runs summarization, categorization, and embedding generation.
3. **Chat (RAG)**: User query → embed via NVIDIA NIM → pgvector similarity search → fetch full thread content → stream answer from Llama 3.1 via NVIDIA NIM.
4. **Email Actions**: Summarize, compose, and reply all go through `/api/summarize` which uses Llama 3.1 for generation.

---

## 2. Database Schema

### Tables

#### `gmail_accounts`
| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID (PK) | Unique account identifier |
| `user_id` | UUID (FK → auth.users) | Supabase auth user |
| `email_address` | TEXT | Gmail address |
| `access_token` | TEXT | OAuth access token (encrypted at rest) |
| `refresh_token` | TEXT | OAuth refresh token |
| `token_expiry` | TIMESTAMPTZ | Token expiration time |
| `history_id` | TEXT | Gmail history ID for incremental sync |
| `last_synced` | TIMESTAMPTZ | Last successful sync time |

#### `email_threads`
| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT (PK) | Gmail thread ID |
| `gmail_account_id` | UUID (FK) | Parent Gmail account |
| `subject` | TEXT | Thread subject line |
| `summary` | TEXT | AI-generated thread summary |
| `participants` | JSONB | Array of `{email}` objects |
| `labels` | TEXT[] | Gmail label IDs |
| `last_message_date` | TIMESTAMPTZ | Most recent message date |
| `embedding` | vector(1024) | Thread embedding for semantic search |

#### `email_messages`
| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT (PK) | Gmail message ID |
| `thread_id` | TEXT (FK) | Parent thread |
| `from_address` | TEXT | Sender address |
| `to_addresses` | TEXT[] | Recipients |
| `cc_addresses` | TEXT[] | CC recipients |
| `date` | TIMESTAMPTZ | Message date |
| `subject` | TEXT | Message subject |
| `body_text` | TEXT | Plain text body |
| `body_html` | TEXT | HTML body |
| `labels` | TEXT[] | Gmail label IDs |
| `raw` | JSONB | Original Gmail metadata |

#### `email_categories`
| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID (PK) | Auto-generated |
| `thread_id` | TEXT (FK, UNIQUE) | One category per thread |
| `category` | TEXT | Category name |
| `confidence` | FLOAT | AI confidence score (0–1) |

### pgvector Usage

We embed `subject + body_text` of each thread using NVIDIA NIM's `nvidia/nv-embedqa-e5-v5` model (1024 dimensions). This enables:
- **Semantic search**: User queries are embedded and matched against thread embeddings using cosine similarity via the `match_threads` SQL function.
- **RAG retrieval**: The chat agent uses the same vector search to find relevant threads before generating answers.

The `match_threads` function uses `1 - (embedding <=> query_embedding)` for cosine similarity with a configurable threshold (default 0.5).

### Indexes
- `email_threads.embedding` — IVFFlat index for fast vector similarity search
- `email_messages.thread_id` — B-tree index for thread message lookups
- `email_categories.thread_id` — Unique index for upserts

---

## 3. AI Design

### Email Summarization

**Strategy**: Thread-level summarization with full context.

1. **Context Assembly**: All messages in a thread are fetched chronologically and concatenated with sender/date metadata.
2. **Truncation**: Threads are truncated to 20,000 characters to stay within Llama 3.1's context window.
3. **Structured Output**: The prompt requests a structured summary with: Topic, Key Points, Action Items, and Decisions Made.
4. **Caching**: Summaries are stored in `email_threads.summary` and reused on subsequent views.

### Chat Agent (RAG Pipeline)

```
User Query
    │
    ▼
┌─────────────┐
│  Embed Query │ ← NVIDIA NIM (nv-embedqa-e5-v5)
└──────┬──────┘
       ▼
┌──────────────┐
│ Vector Search │ ← pgvector cosine similarity (threshold: 0.5)
│  (8 results)  │
└──────┬───────┘
       ▼
┌───────────────┐
│Keyword Fallback│ ← ILIKE search on subject/summary if <3 vector results
└──────┬────────┘
       ▼
┌──────────────────┐
│Fetch Full Content │ ← Top 3 threads: actual message bodies from email_messages
└──────┬───────────┘
       ▼
┌──────────────────┐
│ Stream via SSE    │ ← Llama 3.1-8B-Instruct via NVIDIA NIM
│ with source citing │    System prompt enforces [Source N] notation
└──────────────────┘
```

**Source Clarity**: The system prompt includes numbered source blocks (`[Source 1]`, `[Source 2]`, etc.) with thread subject, date, and full content. The model is instructed to cite sources using `[Source N]` notation.

**Hallucination Prevention**:
- System prompt explicitly states: "Answer ONLY using the provided email context"
- "If the answer is not in the context, say so clearly"
- Context blocks include actual message content, not just summaries
- Source metadata is sent to the frontend separately via `__SOURCES__` tokens for independent display

**Cross-Email Reasoning**: The hybrid search retrieves threads from multiple senders/topics. The model's context window receives all matched threads, enabling synthesis across different email conversations.

### Email Categorization

Categories: Newsletter, Job, Finance, Notification, Personal, Work, Other.

The categorization prompt provides the email's `from_address`, `subject`, and a 300-character preview. The model returns structured JSON with `category`, `confidence` (0–1), and `reason`. Results are stored in `email_categories` and surfaced in the UI as color-coded badges.

### Why NVIDIA NIM (Llama 3.1-8B-Instruct)?

- **Free tier availability**: NVIDIA NIM provides free API access to `meta/llama-3.1-8b-instruct`
- **OpenAI-compatible API**: Uses the standard OpenAI SDK with a custom `baseURL`, making it a drop-in replacement
- **Dual role**: Handles both embeddings (via `nvidia/nv-embedqa-e5-v5`) and text generation
- **Performance**: 8B parameter model is fast enough for real-time streaming while being capable enough for summarization and categorization tasks
- **Streaming support**: Native SSE streaming for chat responses

---

## 4. Gmail API Strategy

### Initial Sync vs. Incremental Sync

| Aspect | Full Sync | Incremental Sync |
|--------|-----------|------------------|
| **Trigger** | First sync or manual | Subsequent syncs |
| **API Call** | `messages.list` with pagination | `history.list` with `startHistoryId` |
| **Volume** | All messages (paginated, 50/page) | Only new/changed messages |
| **Processing** | Parallel batches of 10 | Same parallel processing |

### Pagination Handling

- Gmail API returns max 50 messages per `messages.list` call
- We use `nextPageToken` to iterate through all pages
- Messages are processed in parallel batches of 10 to balance speed vs. rate limits

### Rate Limiting & Quota Management

**Exponential Backoff** (`withBackoff` helper):
- Catches HTTP 429 (Too Many Requests) and 503 (Service Unavailable)
- Retries up to 5 times with exponential delays: `min(1000 * 2^attempt + random(0-500), 32000ms)`
- Applied to all Gmail API calls: `messages.list`, `messages.get`, `messages.send`, `history.list`, `users.getProfile`

**Batch Processing**:
- AI processing (summarize + categorize + embed) runs in parallel batches of 5 threads
- 1-second delay between batches to avoid overwhelming NVIDIA NIM rate limits
- AI failures are caught per-thread (`Promise.allSettled`) so one failure doesn't break the batch

### Token Refresh

- Before each API call, token expiry is checked against `Date.now() - 60s` buffer
- If expired, `oauth2Client.refreshAccessToken()` is called and new credentials stored in Supabase

---

## 5. Tool & Technology Decisions

| Technology | Why |
|------------|-----|
| **Next.js 16** | Full-stack React framework with API routes, SSR, and streaming support. Eliminates need for separate backend. |
| **Supabase** | Managed PostgreSQL with built-in auth, real-time subscriptions, and pgvector support. No infrastructure management. |
| **pgvector** | Native PostgreSQL vector extension for semantic search. Simpler than external vector DBs (Pinecone, Weaviate) and co-located with relational data. |
| **NVIDIA NIM** | Free-tier access to both embedding models and Llama 3.1. OpenAI-compatible API means standard SDK usage. |
| **OpenAI SDK** | Used as a client for NVIDIA NIM (not OpenAI). The SDK provides streaming, retry logic, and TypeScript types. |
| **googleapis** | Official Google client library for Gmail API. Handles OAuth token management and request signing. |
| **Lucide React** | Lightweight, tree-shakeable icon library. ~1KB per icon vs. heavier alternatives. |
| **TypeScript** | Type safety across the full stack. Especially important for complex API response shapes (Gmail, Supabase, AI). |

### Why No Job Queue?

For this assessment scope, synchronous processing during sync is sufficient. In production, we would add:
- Bull/BullMQ with Redis for background processing
- Separate worker processes for AI operations
- Webhook-based Gmail push notifications instead of polling

---

## 6. Trade-offs & Limitations

### Deliberate Simplifications

1. **Synchronous AI Processing**: Summarization, categorization, and embedding happen during the sync API call. In production, these would be background jobs.
2. **Single Gmail Account**: The UI supports one connected Gmail account per user. The schema supports multiple but the UI doesn't expose account switching.
3. **No Push Notifications**: We rely on manual/periodic sync rather than Gmail push notifications (which require a public webhook endpoint).
4. **Client-Side State**: Thread list and selected thread are managed in React state rather than URL params. This means browser back/forward doesn't navigate between emails.
5. **No Email Caching Layer**: Every thread click fetches messages from Supabase. In production, we'd add client-side caching or SWR.

### Known Limitations

- **Context Window**: Llama 3.1-8B has an 8K context window. Very long threads (50+ messages) may be truncated.
- **HTML Email Rendering**: We use a sandboxed iframe for HTML emails. Some emails with complex CSS or external resources may not render perfectly.
- **Rate Limits**: NVIDIA NIM free tier has request limits. Heavy usage during sync may hit limits.
- **No Attachment Handling**: Email attachments are not downloaded or processed.

### What I'd Do With More Time

1. **Background Job Queue**: Move AI processing to async workers with progress tracking
2. **Gmail Push Notifications**: Real-time sync via Cloud Pub/Sub webhooks
3. **Newsletter Deduplication**: Implement the bonus feature using embedding similarity to detect duplicate stories across newsletter sources
4. **Attachment Processing**: Download and index PDF/document attachments
5. **Multi-Account Support**: UI for switching between multiple Gmail accounts
6. **Caching Layer**: Redis or SWR for frequently accessed threads
7. **Email Labels Sync**: Two-way label sync with Gmail
8. **Search Autocomplete**: Typeahead suggestions based on thread subjects and contacts
