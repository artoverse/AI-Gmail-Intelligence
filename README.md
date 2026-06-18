# GmailAI — Intelligent Email Platform

An AI-powered Gmail Intelligence Platform built with Next.js 16, Supabase (PostgreSQL + pgvector), Google Gmail API (OAuth 2.0), Llama 3.1 via NVIDIA NIM, and Google Gemini API.
Live demo: https://ai-gmail-intelligence.onrender.com
## Features

- **OAuth Gmail Integration** — Connect your Gmail via Google OAuth2 with full read/send access
- **Full & Incremental Sync** — Initial full sync + efficient historyId-based incremental updates
- **AI Summarization** — Per-thread summaries via Llama 3.1 (NVIDIA NIM), cached in Supabase
- **Smart Categorization** — AI classification into 7 categories (Newsletter, Job, Finance, Notification, Personal, Work, Other)
- **Semantic Search** — NVIDIA NIM 1024-dim embeddings + pgvector cosine similarity search
- **RAG Chat Agent** — Ask questions grounded in your email data with source citations and streaming responses
- **AI Reply Drafting** — Llama 3.1-powered draft replies from natural language instructions
- **Email Compose & Send** — Full compose and reply via Gmail API

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16 (App Router, TypeScript) |
| Styling | Vanilla CSS (custom design system) |
| Database | Supabase (PostgreSQL + pgvector) |
| Auth | Supabase Auth (Google OAuth provider) |
| Gmail API | Google Gmail API v1 (googleapis, OAuth 2.0) |
| Primary AI | Llama 3.1-8B-Instruct via NVIDIA NIM |
| Secondary AI | Google Gemini API (available as fallback) |
| Embeddings | NVIDIA NIM (nvidia/nv-embedqa-e5-v5, 1024-dim) |
| Deployment | Vercel |

## Project Structure

```
gmail-ai/
├── app/
│   ├── api/
│   │   ├── gmail/
│   │   │   ├── connect/route.ts           # Initiate Gmail OAuth
│   │   │   ├── connect/callback/route.ts  # Handle OAuth code exchange
│   │   │   ├── sync/route.ts              # Full/incremental sync
│   │   │   └── send/route.ts              # Send/reply emails
│   │   ├── chat/route.ts                  # Streaming RAG chat (SSE)
│   │   └── summarize/route.ts             # Summarize + draft reply
│   ├── auth/callback/route.ts             # Supabase Auth callback
│   ├── globals.css                        # Design system
│   ├── layout.tsx                         # Root layout + SEO
│   └── page.tsx                           # Main 3-column UI
├── components/
│   ├── Sidebar.tsx                        # Nav + sync + account
│   ├── ThreadList.tsx                     # Paginated thread list
│   ├── EmailView.tsx                      # Thread reader + summary
│   ├── ChatPanel.tsx                      # RAG chat interface
│   └── ComposeModal.tsx                   # Compose/reply modal
├── lib/
│   ├── supabase.ts                        # DB clients + types
│   ├── gmail.ts                           # OAuth2, sync, send
│   ├── ai.ts                              # Gemini + NIM functions
│   ├── rag.ts                             # Vector search + chat pipeline
│   └── utils.ts                           # Helpers + UI utils
├── supabase/
│   └── schema.sql                         # Full DB schema
├── Architecture.md                        # System design doc
└── .env.example                           # Environment variable template
```

## Setup

### 1. Clone & Install

```bash
git clone <your-repo-url>
cd gmail-ai
npm install
```

### 2. Supabase Setup

1. Create a project at [supabase.com](https://supabase.com)
2. In SQL Editor, run:
   ```sql
   CREATE EXTENSION IF NOT EXISTS vector;
   ```
3. Then run the full contents of `supabase/schema.sql`
4. Go to **Authentication → Providers → Google** and enable Google OAuth
   - Add your Google Client ID and Secret
   - Add `https://your-project.supabase.co/auth/v1/callback` to Google Cloud Console authorized redirect URIs

### 3. Google Cloud Console

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a new project (or use existing)
3. Enable **Gmail API**
4. Configure **OAuth Consent Screen** → External → add your email as test user
5. Create **OAuth 2.0 Client ID** (Web application)
6. Authorized redirect URIs:
   - `http://localhost:3000/api/gmail/connect/callback` (local)
   - `https://your-app.vercel.app/api/gmail/connect/callback` (production)
7. Note your Client ID and Secret

### 4. NVIDIA NIM

1. Sign up at [build.nvidia.com](https://build.nvidia.com)
2. Get a free API key
3. Use model: `nvidia/nv-embedqa-e5-v5`

### 5. Environment Variables

```bash
cp .env.example .env.local
```

Fill in your `.env.local`:

```env
NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...

GOOGLE_CLIENT_ID=xxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-...
NEXT_PUBLIC_APP_URL=http://localhost:3000

GEMINI_API_KEY=AIza...
NVIDIA_NIM_API_KEY=nvapi-...
NVIDIA_NIM_API_BASE=https://integrate.api.nvidia.com/v1
NVIDIA_NIM_EMBED_MODEL=nvidia/nv-embedqa-e5-v5
```

### 6. Run Locally

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

## Usage Guide

### First Time Setup

1. **Sign in** — Click "Continue with Google" (Supabase Auth, no Gmail scope yet)
2. **Connect Gmail** — Click "Connect Gmail" in the sidebar to authorize Gmail API access
3. **Sync** — Click the Sync button → choose "Full Sync" for first run (takes 1-5 min for large inboxes)

### Features

| Feature | How to Use |
|---|---|
| **Browse Emails** | Click any thread in the list |
| **AI Summary** | Open a thread → click "AI Summary" button |
| **Filter by Category** | Click a category in the sidebar (Job, Finance, etc.) |
| **Chat with Emails** | Type in the right panel → ask anything |
| **Compose** | Click "Compose" FAB or "Reply" in thread view |
| **AI Draft** | In compose modal → type an instruction → click "Draft" |
| **Incremental Sync** | Click Sync → "Incremental" (only new emails) |

### Testing Features

```bash
# Test summarization
curl -X POST http://localhost:3000/api/summarize \
  -H "Content-Type: application/json" \
  -d '{"threadId": "YOUR_THREAD_ID", "action": "summarize"}'

# Test chat
curl -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"query": "What are my recent job applications?", "history": []}'
```

## Deployment to Vercel

```bash
# Install Vercel CLI
npm i -g vercel

# Deploy
vercel

# Set environment variables
vercel env add SUPABASE_SERVICE_ROLE_KEY
# ... (add all env vars from .env.example)
```

Update your `NEXT_PUBLIC_APP_URL` to your Vercel URL and add it to Google Cloud Console redirect URIs.

## Architecture

See [Architecture.md](./Architecture.md) for detailed system design, DB schema rationale, AI pipeline design, and trade-offs.
