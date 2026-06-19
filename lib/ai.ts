import OpenAI from 'openai';

// ─────────────────────────────────────────────────────────────
// Provider detection — explicit AI_PROVIDER env var, or auto-detect
// Priority: AI_PROVIDER > NVIDIA_NIM_API_KEY > HF_TOKEN > GEMINI_API_KEY
// ─────────────────────────────────────────────────────────────

type Provider = 'gemini' | 'huggingface' | 'nvidia';

function isValidKey(key: string | undefined): boolean {
  if (!key) return false;
  const k = key.trim();
  // Reject empty, placeholder, or "your_xxx_here" values
  return k.length > 10 && !k.includes('your_') && !k.includes('xxx') && !k.includes('_here');
}

function getProvider(): Provider {
  // Explicit override via env var
  const explicit = process.env.AI_PROVIDER?.toLowerCase();
  if (explicit === 'gemini' && isValidKey(process.env.GEMINI_API_KEY)) return 'gemini';
  if (explicit === 'huggingface' && isValidKey(process.env.HF_TOKEN)) return 'huggingface';
  if (explicit === 'nvidia' && isValidKey(process.env.NVIDIA_NIM_API_KEY)) return 'nvidia';

  // Auto-detect: prefer NVIDIA NIM (most reliable for this app), then HF, then Gemini
  if (isValidKey(process.env.NVIDIA_NIM_API_KEY)) return 'nvidia';
  if (isValidKey(process.env.HF_TOKEN)) return 'huggingface';
  if (isValidKey(process.env.GEMINI_API_KEY)) return 'gemini';

  // Fallback — will likely error, but at least tries
  return 'nvidia';
}

function getModelId(): string {
  const provider = getProvider();
  if (provider === 'gemini') {
    return process.env.GEMINI_MODEL ?? 'gemini-2.0-flash';
  }
  if (provider === 'huggingface') {
    const hfModel = process.env.HF_MODEL ?? 'meta-llama/Llama-3.2-3B-Instruct';
    // Remap models too large for HF free tier (this causes 404s)
    if (hfModel.includes('70B') || hfModel.includes('405B') || hfModel.includes('DeepSeek-R1')) {
      if (!hfModel.includes('Distill')) {
        return 'meta-llama/Llama-3.2-3B-Instruct';
      }
    }
    return hfModel;
  }
  // NVIDIA NIM fallback
  let nimModel = process.env.NVIDIA_NIM_MODEL ?? 'meta/llama-3.3-70b-instruct';
  // If user accidentally pasted the HF model string into the NIM variable, correct it
  if (nimModel.toLowerCase().includes('llama-3.3-70b')) {
    nimModel = 'meta/llama-3.3-70b-instruct';
  }
  return nimModel;
}

let _client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!_client) {
    const provider = getProvider();
    console.log(`[AI] Using provider: ${provider}, model: ${getModelId()}`);
    if (provider === 'gemini') {
      _client = new OpenAI({
        apiKey: process.env.GEMINI_API_KEY!,
        baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
      });
    } else if (provider === 'huggingface') {
      _client = new OpenAI({
        apiKey: process.env.HF_TOKEN!,
        baseURL: 'https://api-inference.huggingface.co/v1/',
      });
    } else {
      _client = new OpenAI({
        apiKey: process.env.NVIDIA_NIM_API_KEY!,
        baseURL: process.env.NVIDIA_NIM_API_BASE ?? 'https://integrate.api.nvidia.com/v1',
      });
    }
  }
  return _client;
}

const EMBED_MODEL = process.env.NVIDIA_NIM_EMBED_MODEL ?? 'nvidia/nv-embedqa-e5-v5';
const NIM_BASE = process.env.NVIDIA_NIM_API_BASE ?? 'https://integrate.api.nvidia.com/v1';

// ─────────────────────────────────────────────────────────────
// DeepSeek / thinking model output cleaner
// DeepSeek-R1 wraps reasoning in <think>…</think> — strip it
// ─────────────────────────────────────────────────────────────
function cleanResponse(text: string): string {
  // Remove <think>...</think> blocks (DeepSeek chain-of-thought)
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<Think>[\s\S]*?<\/Think>/gi, '')
    .trim();
}

// ─────────────────────────────────────────────────────────────
// Text Embedding (NVIDIA NIM) — always uses NIM for embeddings
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
// Thread Summarization
// ─────────────────────────────────────────────────────────────

export async function summarizeThread(threadText: string): Promise<string> {
  const client = getClient();
  const model = getModelId();
  const truncated = threadText.slice(0, 12_000);

  const response = await client.chat.completions.create({
    model,
    messages: [
      {
        role: 'system',
        content: 'You are an expert email analyst. Output ONLY the summary — no preamble, no meta-commentary, no thinking steps.',
      },
      {
        role: 'user',
        content: `Summarize this email thread using this exact format:

**Topic**: [One sentence]

**Key Points**:
• [Point 1]
• [Point 2]
• [Point 3 if relevant]

**Action Items**: [Specific tasks/deadlines, or "None"]

**Outcome**: [Decision made or "Pending"]

Email thread:
${truncated}

Write the summary now (max 200 words):`,
      },
    ],
    max_tokens: 400,
    temperature: 0.2,
  });

  const raw = response.choices[0]?.message?.content ?? '';
  return cleanResponse(raw);
}

// ─────────────────────────────────────────────────────────────
// Email Categorization
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
  const client = getClient();
  const model = getModelId();

  const systemPrompt = `You are an email classifier. Output ONLY valid JSON. No explanations, no reasoning, no thinking steps.`;

  const userPrompt = `Classify this email into exactly ONE category.

Categories:
- Newsletter: Marketing, subscriptions, digests, blog posts, product updates
- Job: Job alerts, applications, recruiters, LinkedIn jobs, career opportunities
- Finance: Bank statements, invoices, payments, receipts, billing, transactions
- Notification: System alerts, OTPs, app notifications, security alerts, account updates
- Personal: Messages from real people (friends, family, colleagues writing personally)
- Work: Business emails, team communication, meeting invites, project updates
- Other: Anything not fitting above

Email:
From: ${fromAddress}
Subject: ${subject}
Preview: ${snippet?.slice(0, 400) ?? ''}

Respond with JSON only in this exact format:
{"category":"<one category>","confidence":<0.1-1.0>,"reason":"<one short sentence>"}`;

  try {
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 120,
      temperature: 0.1,
    });

    const raw = cleanResponse(response.choices[0]?.message?.content ?? '');

    // Try to extract JSON even if the model added surrounding text
    const match = raw.match(/\{[\s\S]*?\}/);
    if (!match) throw new Error('No JSON in response');
    return JSON.parse(match[0]) as EmailCategoryResult;
  } catch {
    return { category: 'Other', confidence: 0.4, reason: 'Could not parse AI response' };
  }
}

// ─────────────────────────────────────────────────────────────
// Reply Drafting
// ─────────────────────────────────────────────────────────────

export async function draftReply(
  threadText: string,
  instruction: string,
  userEmail: string
): Promise<string> {
  const client = getClient();
  const model = getModelId();

  const response = await client.chat.completions.create({
    model,
    messages: [
      {
        role: 'system',
        content: `You are a professional email writer for ${userEmail}. Write ONLY the email body. No subject lines, no "From:", no reasoning. Just the email text, ready to send.`,
      },
      {
        role: 'user',
        content: `Write a reply to this email thread based on this instruction: "${instruction}"

Original thread:
${threadText.slice(0, 12_000)}

Requirements:
- Match the tone of the conversation
- Keep it under 200 words
- Sign off naturally
- Do NOT include Subject:, From:, To: headers`,
      },
    ],
    max_tokens: 500,
    temperature: 0.4,
  });

  return cleanResponse(response.choices[0]?.message?.content ?? '');
}

// ─────────────────────────────────────────────────────────────
// Compose New Email
// ─────────────────────────────────────────────────────────────
export async function draftNewEmail(
  instruction: string,
  userEmail: string
): Promise<{ subject: string; draft: string }> {
  const client = getClient();
  const model = getModelId();

  const response = await client.chat.completions.create({
    model,
    messages: [
      {
        role: 'system',
        content: `You are an expert email writer. Output ONLY valid JSON in this exact format with no extra text:
{"subject":"<concise subject line>","draft":"<professional email body, no headers>"}`,
      },
      {
        role: 'user',
        content: `Write a professional email for: "${instruction}"\nSender: ${userEmail}\nKeep body under 200 words.`,
      },
    ],
    max_tokens: 600,
    temperature: 0.4,
  });

  const raw = cleanResponse(response.choices[0]?.message?.content ?? '');
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : raw);
    return { subject: parsed.subject ?? '', draft: parsed.draft ?? raw };
  } catch {
    return { subject: '', draft: raw };
  }
}

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
  const client = getClient();
  const model = getModelId();

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
6. Output ONLY your final answer — no thinking, no reasoning steps

${chatHistory.length > 0 ? `Previous conversation:\n${historyText}\n\n` : ''}

Email context:
${contextBlocks || 'No relevant emails found.'}

User's question: ${query}

Answer:`;

  const response = await client.chat.completions.create({
    model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 500,
  });

  return cleanResponse(response.choices[0]?.message?.content ?? '');
}

// ─────────────────────────────────────────────────────────────
// Streaming Chat
// ─────────────────────────────────────────────────────────────

export async function* generateGroundedAnswerStream(
  query: string,
  retrievedThreads: (RetrievedThread & { content?: string })[],
  chatHistory: ChatMessage[],
  inboxMeta?: { totalThreads: number; totalMessages: number }
): AsyncGenerator<string> {
  const client = getClient();
  const model = getModelId();
  const provider = getProvider();

  // Detect newsletter / news digest queries → trigger deduplication instruction
  const isNewsletterQuery = /newsletter|news digest|tech news|what('s| is) new|recent news|top stories|headlines/i.test(query);

  // Build rich context blocks — prefer actual message content over summaries
  const contextBlocks = retrievedThreads
    .map((t, i) => {
      const date = t.last_message_date
        ? new Date(t.last_message_date).toLocaleString('en-US', {
            month: 'short', day: 'numeric', year: 'numeric',
            hour: '2-digit', minute: '2-digit',
          })
        : 'unknown date';
      const content = (t as any).content?.trim() || t.summary || 'No content available';
      return (
        `[Source ${i + 1}]\n` +
        `Subject: ${t.subject ?? 'No Subject'}\n` +
        `Date: ${date}\n` +
        `Content:\n${content.slice(0, 3000)}`
      );
    })
    .join('\n\n━━━\n\n');

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = chatHistory
    .slice(-8)
    .map(m => ({
      role: m.role === 'model' ? 'assistant' : 'user',
      content: m.content,
    }));

  const inboxStats = inboxMeta
    ? `Inbox stats: ${inboxMeta.totalThreads} total threads, ${inboxMeta.totalMessages} total messages synced.`
    : '';

  let systemPrompt: string;

  if (retrievedThreads.length === 0) {
    systemPrompt = `You are a Gmail AI assistant. No emails have been indexed yet. Tell the user to sync their Gmail using the Sync button. Output ONLY your response, no thinking steps.`;
  } else if (isNewsletterQuery) {
    systemPrompt = `You are an intelligent Gmail assistant specializing in newsletter digest and deduplication.
Output ONLY your final answer. No reasoning, no thinking steps, no <think> tags.

${inboxStats}

NEWSLETTER DEDUPLICATION RULES:
- Identify all unique news stories/topics across ALL sources below
- If the same story appears in multiple newsletters, group them under ONE entry
- List each unique story ONCE, with attribution like: "From [Source 1], [Source 3]"
- Remove pure duplicates — same story, different wording = one entry
- Format as a clean numbered list: "1. **Story Title** — brief summary [Source N, Source M]"
- Sort by recency/importance

Email context (${retrievedThreads.length} newsletter/email sources):
━━━
${contextBlocks}
━━━`;
  } else {
    systemPrompt = `You are an intelligent Gmail assistant. Answer questions using the email context below.
Output ONLY your final answer. No reasoning, no thinking steps, no <think> tags.

${inboxStats}

STRICT RULES:
- Cite sources with [Source N] for every fact you state
- Answer directly using ALL available sources — synthesize across emails when needed
- Use inbox stats for total count questions ("how many emails do I have")
- The context shows the ${retrievedThreads.length} most relevant emails for this query
- Be specific with dates, names, senders, and dollar amounts
- For "most recent"/"latest" → sort by Date field and list in order
- For cross-email reasoning → synthesize ALL matching sources
- If info isn't in the context, say exactly: "I don't see that in your synced emails"
- NEVER hallucinate — only state facts from the context below

Email context (${retrievedThreads.length} most relevant emails):
━━━
${contextBlocks}
━━━`;
  }

  messages.unshift({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: query });

  // DeepSeek-R1 models do NOT support streaming well via HF — use non-streaming for HF
  if (provider === 'huggingface') {
    const response = await client.chat.completions.create({
      model,
      messages,
      stream: false,
      max_tokens: 1500,
      temperature: 0.3,
    });
    const text = cleanResponse(response.choices[0]?.message?.content ?? '');
    // Yield in chunks to simulate streaming so UI works the same
    const words = text.split(' ');
    for (const word of words) {
      yield word + ' ';
    }
    return;
  }

  // Gemini and NVIDIA NIM support streaming natively
  const stream = await client.chat.completions.create({
    model,
    messages,
    stream: true,
    max_tokens: 1500,
    temperature: 0.2,
  });

  let thinkBuffer = '';
  let inThinkTag = false;

  for await (const chunk of stream) {
    const content = chunk.choices[0]?.delta?.content;
    if (!content) continue;

    // Strip DeepSeek <think>...</think> tags from streaming output
    thinkBuffer += content;
    if (thinkBuffer.includes('<think>')) inThinkTag = true;
    if (inThinkTag) {
      if (thinkBuffer.includes('</think>')) {
        inThinkTag = false;
        const after = thinkBuffer.split('</think>').pop() ?? '';
        thinkBuffer = '';
        if (after) yield after;
      }
      // Skip while inside think tag
      continue;
    }

    // Not in think tag — yield directly
    yield content;
    thinkBuffer = '';
  }
}
