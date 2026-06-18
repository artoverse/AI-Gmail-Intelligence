import OpenAI from 'openai';

// ─────────────────────────────────────────────────────────────
// Client Init (lazy to avoid build-time errors)
// ─────────────────────────────────────────────────────────────

let _hfClient: OpenAI | null = null;
function getHfClient() {
  if (!_hfClient) {
    _hfClient = new OpenAI({
      apiKey: process.env.NVIDIA_NIM_API_KEY!,
      baseURL: process.env.NVIDIA_NIM_API_BASE ?? 'https://integrate.api.nvidia.com/v1',
    });
  }
  return _hfClient;
}

const HF_MODEL = 'meta/llama-3.1-8b-instruct';
const EMBED_MODEL = process.env.NVIDIA_NIM_EMBED_MODEL ?? 'nvidia/nv-embedqa-e5-v5';
const NIM_BASE = process.env.NVIDIA_NIM_API_BASE ?? 'https://integrate.api.nvidia.com/v1';

// ─────────────────────────────────────────────────────────────
// Text Embedding (NVIDIA NIM) — using raw fetch for full control
// ─────────────────────────────────────────────────────────────

async function nimEmbed(text: string, inputType: 'query' | 'passage'): Promise<number[]> {
  const truncated = text.slice(0, 8000);

  const res = await fetch(`${NIM_BASE}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.NVIDIA_NIM_API_KEY}`,
    },
    body: JSON.stringify({
      model: EMBED_MODEL,
      input: truncated,
      input_type: inputType,
      encoding_format: 'float',
      truncate: 'END',
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`NIM embedding failed (${res.status}): ${errText}`);
  }

  const data = await res.json();
  return data.data[0].embedding as number[];
}

export async function embedText(text: string): Promise<number[]> {
  return nimEmbed(text, 'query');
}

export async function embedPassage(text: string): Promise<number[]> {
  return nimEmbed(text, 'passage');
}

// ─────────────────────────────────────────────────────────────
// Thread Summarization (Llama 3 via Hugging Face)
// ─────────────────────────────────────────────────────────────

export async function summarizeThread(threadText: string): Promise<string> {
  const client = getHfClient();
  const truncated = threadText.slice(0, 20_000); // Keep under Llama 3 context limits

  const prompt = `You are an expert email summarizer. Analyze this email thread and provide a concise summary.

Email thread:
${truncated}

Provide a structured summary with:
1. **Topic**: One sentence describing the main subject
2. **Key Points**: 2-4 bullet points of important information
3. **Action Items**: Any tasks, deadlines, or follow-ups required
4. **Decision Made**: Any conclusions or decisions reached (if applicable)

Keep the total summary under 150 words. Be specific, not generic.`;

  const response = await client.chat.completions.create({
    model: HF_MODEL,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 300,
  });

  return response.choices[0]?.message?.content || '';
}

// ─────────────────────────────────────────────────────────────
// Email Categorization (Llama 3 via Hugging Face)
// ─────────────────────────────────────────────────────────────

export type EmailCategoryResult = {
  category: 'Newsletter' | 'Job' | 'Finance' | 'Notification' | 'Personal' | 'Work' | 'Other';
  confidence: number;
  reason: string;
};

export async function categorizeEmail(
  subject: string,
  fromAddress: string,
  snippet: string
): Promise<EmailCategoryResult> {
  const client = getHfClient();

  const prompt = `Categorize this email into exactly one category.

Categories:
- Newsletter: Marketing emails, subscriptions, digests, announcements
- Job: Job alerts, applications, recruiter messages, LinkedIn jobs
- Finance: Bank statements, invoices, payments, receipts, transactions
- Notification: System alerts, app notifications, account updates
- Personal: Messages from real people, friends, family
- Work: Business emails, team communication, project-related
- Other: Anything that doesn't fit the above

Email details:
From: ${fromAddress}
Subject: ${subject}
Preview: ${snippet?.slice(0, 300)}

Respond with valid JSON only:
{
  "category": "<one of the categories above>",
  "confidence": <0.0 to 1.0>,
  "reason": "<one sentence explaining why>"
}`;

  const response = await client.chat.completions.create({
    model: HF_MODEL,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 150,
  });

  const text = response.choices[0]?.message?.content || '';

  try {
    // Attempt to extract JSON from response
    const match = text.match(/\{[\s\S]*\}/);
    const jsonStr = match ? match[0] : text;
    return JSON.parse(jsonStr) as EmailCategoryResult;
  } catch {
    return { category: 'Other', confidence: 0.5, reason: 'Could not parse response' };
  }
}

// ─────────────────────────────────────────────────────────────
// Reply Drafting (Llama 3 via Hugging Face)
// ─────────────────────────────────────────────────────────────

export async function draftReply(
  threadText: string,
  instruction: string,
  userEmail: string
): Promise<string> {
  const client = getHfClient();

  const prompt = `You are drafting an email reply for ${userEmail}.

Original email thread (most recent last):
${threadText.slice(0, 20_000)}

User's instruction for reply: "${instruction}"

Write a professional, concise email reply. 
- Match the tone of the conversation
- Do NOT include subject line or headers
- Do NOT add "Subject:" or "From:" etc.
- Just write the email body text
- Sign off naturally based on context
- Keep it under 200 words unless the instruction requires more`;

  const response = await client.chat.completions.create({
    model: HF_MODEL,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 400,
  });

  return response.choices[0]?.message?.content || '';
}

// ─────────────────────────────────────────────────────────────
// RAG Answer Generation (Llama 3 via Hugging Face)
// ─────────────────────────────────────────────────────────────

export type ChatMessage = {
  role: 'user' | 'model';
  content: string;
};

export type RetrievedThread = {
  id: string;
  subject: string | null;
  summary: string | null;
  similarity: number;
  last_message_date: string | null;
};

export async function generateGroundedAnswer(
  query: string,
  retrievedThreads: RetrievedThread[],
  chatHistory: ChatMessage[]
): Promise<string> {
  const client = getHfClient();

  const contextBlocks = retrievedThreads
    .map(
      (t, i) =>
        `[Source ${i + 1}] Thread: "${t.subject ?? 'No Subject'}" (${t.last_message_date ? new Date(t.last_message_date).toLocaleDateString() : 'unknown date'})\n` +
        `Summary: ${t.summary ?? 'No summary available'}\n` +
        `Thread ID: ${t.id}\n` +
        `Similarity: ${(t.similarity * 100).toFixed(0)}%`
    )
    .join('\n\n---\n\n');

  const historyText = chatHistory
    .slice(-6)
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n');

  const prompt = `You are an intelligent Gmail assistant that answers questions about the user's emails.

IMPORTANT RULES:
1. Answer ONLY using the provided email context below
2. If the answer is not in the context, say "I don't have information about that in your emails"
3. Always cite sources using [Source N] notation
4. Be specific with dates, names, and amounts when available
5. Do not hallucinate or make up information

${chatHistory.length > 0 ? `Previous conversation:\n${historyText}\n\n` : ''}

Email context retrieved for this query:
${contextBlocks || 'No relevant emails found.'}

User's question: ${query}

Answer the question based strictly on the email context above, citing sources:`;

  const response = await client.chat.completions.create({
    model: HF_MODEL,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 500,
  });

  return response.choices[0]?.message?.content || '';
}

// ─────────────────────────────────────────────────────────────
// Streaming Chat (returns generator)
// ─────────────────────────────────────────────────────────────

export async function* generateGroundedAnswerStream(
  query: string,
  retrievedThreads: (RetrievedThread & { content?: string })[],
  chatHistory: ChatMessage[]
): AsyncGenerator<string> {
  const client = getHfClient();

  // Build rich context blocks — prefer actual message content over summaries
  const contextBlocks = retrievedThreads
    .map(
      (t, i) => {
        const date = t.last_message_date
          ? new Date(t.last_message_date).toLocaleString('en-US', {
              month: 'short', day: 'numeric', year: 'numeric',
              hour: '2-digit', minute: '2-digit'
            })
          : 'unknown date';
        const content = t.content?.trim() || t.summary || 'No content available';
        return (
          `[Source ${i + 1}]\n` +
          `Subject: ${t.subject ?? 'No Subject'}\n` +
          `Date: ${date}\n` +
          `Content:\n${content.slice(0, 3000)}`
        );
      }
    )
    .join('\n\n━━━\n\n');

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = chatHistory
    .slice(-8)
    .map(m => ({
      role: m.role === 'model' ? 'assistant' : 'user',
      content: m.content
    }));

  const noEmailsMsg = retrievedThreads.length === 0
    ? 'No emails have been indexed yet. Please sync your Gmail first using the Sync button in the sidebar.'
    : '';

  const systemPrompt = retrievedThreads.length === 0
    ? `You are a Gmail AI assistant. ${noEmailsMsg}`
    : `You are an intelligent Gmail assistant. Answer questions using the email context below.

STRICT RULES:
- Use [Source N] to cite where info came from
- Answer directly and completely using ALL available sources
- Never say "I only have N emails" — just answer with what you have
- Be specific with dates, names, senders, and details
- If info isn't in the context, say "I don't see that in your synced emails"
- For "most recent" or "latest" questions, sort by Date and list them in order

Email context (${retrievedThreads.length} emails):
━━━
${contextBlocks}
━━━`;

  messages.unshift({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: query });

  const stream = await client.chat.completions.create({
    model: HF_MODEL,
    messages,
    stream: true,
    max_tokens: 1500,
    temperature: 0.2,  // low temp = more accurate, less hallucination
  });

  for await (const chunk of stream) {
    const content = chunk.choices[0]?.delta?.content;
    if (content) yield content;
  }
}
