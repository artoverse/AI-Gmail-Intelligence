// ─────────────────────────────────────────────────────────────
// HTML to Plain Text
// ─────────────────────────────────────────────────────────────

export function htmlToText(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ─────────────────────────────────────────────────────────────
// Truncate text to token-safe length
// ─────────────────────────────────────────────────────────────

export function truncateText(text: string, maxChars = 8000): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '...[truncated]';
}

// ─────────────────────────────────────────────────────────────
// Format email address display
// ─────────────────────────────────────────────────────────────

export function formatEmailAddress(raw: string): { name: string; email: string } {
  const match = raw.match(/^(.*?)\s*<(.+)>$/);
  if (match) {
    return {
      name: match[1].replace(/"/g, '').trim(),
      email: match[2].trim(),
    };
  }
  return { name: raw, email: raw };
}

export function getEmailInitials(nameOrEmail: string): string {
  const name = nameOrEmail.split('@')[0];
  const parts = name.split(/[\s._-]/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

// ─────────────────────────────────────────────────────────────
// Relative date formatting
// ─────────────────────────────────────────────────────────────

export function formatRelativeDate(dateStr: string | null): string {
  if (!dateStr) return 'Unknown';
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ─────────────────────────────────────────────────────────────
// Category styling
// ─────────────────────────────────────────────────────────────

export const CATEGORY_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  Newsletter: {
    bg: 'bg-purple-500/20',
    text: 'text-purple-300',
    border: 'border-purple-500/30',
  },
  Job: {
    bg: 'bg-blue-500/20',
    text: 'text-blue-300',
    border: 'border-blue-500/30',
  },
  Finance: {
    bg: 'bg-emerald-500/20',
    text: 'text-emerald-300',
    border: 'border-emerald-500/30',
  },
  Notification: {
    bg: 'bg-amber-500/20',
    text: 'text-amber-300',
    border: 'border-amber-500/30',
  },
  Personal: {
    bg: 'bg-pink-500/20',
    text: 'text-pink-300',
    border: 'border-pink-500/30',
  },
  Work: {
    bg: 'bg-cyan-500/20',
    text: 'text-cyan-300',
    border: 'border-cyan-500/30',
  },
  Other: {
    bg: 'bg-slate-500/20',
    text: 'text-slate-300',
    border: 'border-slate-500/30',
  },
};

export const CATEGORY_ICONS: Record<string, string> = {
  Newsletter: '📰',
  Job: '💼',
  Finance: '💰',
  Notification: '🔔',
  Personal: '👤',
  Work: '🏢',
  Other: '📧',
};

// ─────────────────────────────────────────────────────────────
// Generate avatar color from string
// ─────────────────────────────────────────────────────────────

export function getAvatarColor(seed: string): string {
  const colors = [
    'from-violet-500 to-purple-600',
    'from-blue-500 to-cyan-600',
    'from-emerald-500 to-teal-600',
    'from-orange-500 to-amber-600',
    'from-pink-500 to-rose-600',
    'from-indigo-500 to-blue-600',
  ];
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = seed.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

// ─────────────────────────────────────────────────────────────
// Chunk long text for LLM processing
// ─────────────────────────────────────────────────────────────

export function chunkText(text: string, chunkSize = 6000, overlap = 500): string[] {
  if (text.length <= chunkSize) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    chunks.push(text.slice(start, start + chunkSize));
    start += chunkSize - overlap;
  }
  return chunks;
}
