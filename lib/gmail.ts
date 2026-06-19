import { google } from 'googleapis';
import { supabaseAdmin } from './supabase';
import { htmlToText } from './utils';

// ─────────────────────────────────────────────────────────────
// OAuth2 Client Factory
// ─────────────────────────────────────────────────────────────

export function createOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID!,
    process.env.GOOGLE_CLIENT_SECRET!,
    `${process.env.NEXT_PUBLIC_APP_URL}/api/gmail/connect/callback`
  );
}

export function getAuthUrl(): string {
  const oauth2Client = createOAuth2Client();
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/userinfo.email',
    ],
  });
}

// ─────────────────────────────────────────────────────────────
// Token Management
// ─────────────────────────────────────────────────────────────

export async function getValidClient(gmailAccountId: string) {
  const { data: account, error } = await supabaseAdmin
    .from('gmail_accounts')
    .select('*')
    .eq('id', gmailAccountId)
    .single();

  if (error || !account) throw new Error('Gmail account not found');

  const oauth2Client = createOAuth2Client();
  oauth2Client.setCredentials({
    access_token: account.access_token,
    refresh_token: account.refresh_token,
    expiry_date: account.token_expiry ? new Date(account.token_expiry).getTime() : undefined,
  });

  // Auto-refresh if expired
  const expiryTime = account.token_expiry ? new Date(account.token_expiry).getTime() : 0;
  if (Date.now() > expiryTime - 60_000) {
    const { credentials } = await oauth2Client.refreshAccessToken();
    oauth2Client.setCredentials(credentials);

    await supabaseAdmin
      .from('gmail_accounts')
      .update({
        access_token: credentials.access_token,
        token_expiry: credentials.expiry_date
          ? new Date(credentials.expiry_date).toISOString()
          : null,
      })
      .eq('id', gmailAccountId);
  }

  return { oauth2Client, account };
}

// ─────────────────────────────────────────────────────────────
// Exponential Backoff Helper
// ─────────────────────────────────────────────────────────────

async function withBackoff<T>(fn: () => Promise<T>, retries = 5): Promise<T> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const status = (err as { status?: number; code?: number })?.status || (err as { status?: number; code?: number })?.code;
      if ((status === 429 || status === 503) && attempt < retries - 1) {
        const delay = Math.min(1000 * 2 ** attempt + Math.random() * 500, 32_000);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw new Error('Max retries exceeded');
}

// ─────────────────────────────────────────────────────────────
// Email Body Extraction
// ─────────────────────────────────────────────────────────────

function extractBody(payload: GooglePayload): { text: string; html: string } {
  let text = '';
  let html = '';

  function walk(part: GooglePayload) {
    if (!part) return;
    if (part.mimeType === 'text/plain' && part.body?.data) {
      try {
        text += Buffer.from(part.body.data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
      } catch {}
    } else if (part.mimeType === 'text/html' && part.body?.data) {
      try {
        html += Buffer.from(part.body.data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
      } catch {}
    }
    if (part.parts) part.parts.forEach(walk);
  }

  walk(payload);
  return { text, html };
}

type GooglePayload = {
  mimeType?: string;
  body?: { data?: string; size?: number };
  parts?: GooglePayload[];
  headers?: Array<{ name: string; value: string }>;
};

function getHeader(headers: Array<{ name: string; value: string }>, name: string): string {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
}

// ─────────────────────────────────────────────────────────────
// Full Sync: fetch all messages with pagination
// ─────────────────────────────────────────────────────────────

export async function syncGmailFull(
  gmailAccountId: string,
  onProgress?: (count: number) => void
): Promise<{ synced: number; historyId: string | null }> {
  const { oauth2Client, account } = await getValidClient(gmailAccountId);
  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  let pageToken: string | undefined;
  let synced = 0;
  let lastHistoryId: string | null = null;
  const MAX_PAGES = 10; // up to 500 messages per full sync
  let pagesFetched = 0;

  do {
    const listRes = await withBackoff(() =>
      gmail.users.messages.list({
        userId: 'me',
        maxResults: 50,
        pageToken,
      })
    );

    const messages = listRes.data.messages ?? [];
    pageToken = listRes.data.nextPageToken ?? undefined;
    pagesFetched++;

    // Process in parallel batches of 10
    for (let i = 0; i < messages.length; i += 10) {
      const batch = messages.slice(i, i + 10);
      await Promise.all(
        batch.map((msg) => upsertMessage(gmail, account.id, msg.id!))
      );
      synced += batch.length;
      onProgress?.(synced);
    }
  } while (pageToken && pagesFetched < MAX_PAGES);

  // Fetch profile for current historyId
  try {
    const profile = await gmail.users.getProfile({ userId: 'me' });
    lastHistoryId = profile.data.historyId ?? null;
    await supabaseAdmin
      .from('gmail_accounts')
      .update({ history_id: lastHistoryId, last_synced: new Date().toISOString() })
      .eq('id', gmailAccountId);
  } catch {}

  return { synced, historyId: lastHistoryId };
}

// ─────────────────────────────────────────────────────────────
// Incremental Sync: historyId-based
// ─────────────────────────────────────────────────────────────

export async function syncGmailIncremental(
  gmailAccountId: string
): Promise<{ synced: number; historyId: string | null }> {
  const { oauth2Client, account } = await getValidClient(gmailAccountId);

  if (!account.history_id) {
    return syncGmailFull(gmailAccountId);
  }

  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
  let pageToken: string | undefined;
  const messageIds = new Set<string>();
  let newHistoryId = account.history_id;

  do {
    const histRes = await withBackoff(() =>
      gmail.users.history.list({
        userId: 'me',
        startHistoryId: account.history_id!,
        pageToken,
        historyTypes: ['messageAdded', 'messageDeleted', 'labelAdded', 'labelRemoved'],
      })
    );

    if (histRes.data.historyId) newHistoryId = histRes.data.historyId;
    const history = histRes.data.history ?? [];

    for (const h of history) {
      for (const m of h.messagesAdded ?? []) {
        if (m.message?.id) messageIds.add(m.message.id);
      }
    }

    pageToken = histRes.data.nextPageToken ?? undefined;
  } while (pageToken);

  const ids = Array.from(messageIds);
  for (let i = 0; i < ids.length; i += 10) {
    await Promise.all(ids.slice(i, i + 10).map((id) => upsertMessage(gmail, gmailAccountId, id)));
  }

  await supabaseAdmin
    .from('gmail_accounts')
    .update({ history_id: newHistoryId, last_synced: new Date().toISOString() })
    .eq('id', gmailAccountId);

  return { synced: ids.length, historyId: newHistoryId };
}

// ─────────────────────────────────────────────────────────────
// Upsert a single message into the DB
// ─────────────────────────────────────────────────────────────

async function upsertMessage(
  gmail: ReturnType<typeof google.gmail>,
  gmailAccountId: string,
  messageId: string
) {
  const msgRes = await withBackoff(() =>
    gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full',
    })
  );

  const msg = msgRes.data;
  const headers = (msg.payload?.headers as Array<{ name: string; value: string }>) ?? [];
  const { text: extractedText, html: bodyHtml } = extractBody(msg.payload as GooglePayload);
  const bodyText = extractedText.trim() ? extractedText : htmlToText(bodyHtml);

  const fromAddr = getHeader(headers, 'from');
  const toStr = getHeader(headers, 'to');
  const ccStr = getHeader(headers, 'cc');
  const subject = getHeader(headers, 'subject');
  const dateStr = getHeader(headers, 'date');
  const threadId = msg.threadId!;

  const toAddresses = toStr ? toStr.split(',').map((s) => s.trim()).filter(Boolean) : [];
  const ccAddresses = ccStr ? ccStr.split(',').map((s) => s.trim()).filter(Boolean) : [];
  const date = dateStr ? new Date(dateStr).toISOString() : new Date().toISOString();

  // THREAD MUST be upserted FIRST — email_messages.thread_id has a FK to email_threads.id
  const participants = [
    ...toAddresses.map((e) => ({ email: e })),
    { email: fromAddr },
  ].filter((p, i, arr) => arr.findIndex((x) => x.email === p.email) === i);

  const { error: threadError } = await supabaseAdmin.from('email_threads').upsert({
    id: threadId,
    gmail_account_id: gmailAccountId,
    subject,
    participants,
    last_message_date: date,
    labels: msg.labelIds ?? [],
  }, {
    onConflict: 'id',
    ignoreDuplicates: false,
  });
  if (threadError) {
    console.error('Thread upsert error:', threadError.message, 'for thread', threadId);
    return; // Don't try to insert message if thread failed — FK will reject it
  }

  // Now upsert message (thread exists, FK is satisfied)
  const { error: msgError } = await supabaseAdmin.from('email_messages').upsert({
    id: messageId,
    thread_id: threadId,
    from_address: fromAddr,
    to_addresses: toAddresses,
    cc_addresses: ccAddresses,
    date,
    subject,
    body_text: bodyText.slice(0, 50_000),
    body_html: bodyHtml.slice(0, 100_000),
    labels: msg.labelIds ?? [],
    raw: { id: msg.id, threadId: msg.threadId, snippet: msg.snippet },
  }, { onConflict: 'id' });
  if (msgError) console.error('Message upsert error:', msgError.message, 'for message', messageId);
}

// ─────────────────────────────────────────────────────────────
// Send / Reply Email
// ─────────────────────────────────────────────────────────────

export async function sendEmail(
  gmailAccountId: string,
  options: {
    to: string;
    subject: string;
    body: string;
    threadId?: string;
    inReplyTo?: string;
    references?: string;
  }
): Promise<string> {
  const { oauth2Client } = await getValidClient(gmailAccountId);
  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  const profile = await gmail.users.getProfile({ userId: 'me' });
  const from = profile.data.emailAddress!;

  const headers: string[] = [
    `From: ${from}`,
    `To: ${options.to}`,
    `Subject: ${options.subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
  ];

  if (options.inReplyTo) headers.push(`In-Reply-To: ${options.inReplyTo}`);
  if (options.references) headers.push(`References: ${options.references}`);

  const raw = Buffer.from(
    headers.join('\r\n') + '\r\n\r\n' + options.body
  ).toString('base64url');

  const res = await withBackoff(() =>
    gmail.users.messages.send({
      userId: 'me',
      requestBody: {
        raw,
        threadId: options.threadId,
      },
    })
  );

  return res.data.id!;
}
