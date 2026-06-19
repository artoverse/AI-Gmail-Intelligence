'use client';

import { useState, useEffect, useCallback } from 'react';
import type { EmailThread, EmailMessage } from '@/lib/supabase';
import {
  formatRelativeDate,
  CATEGORY_COLORS,
  CATEGORY_ICONS,
  formatEmailAddress,
  htmlToText,
  getAvatarColor,
  getEmailInitials,
} from '@/lib/utils';
import {
  Sparkles,
  Reply,
  Loader2,
  ChevronDown,
  ChevronUp,
  Tag,
  Calendar,
  Users,
} from 'lucide-react';
import ComposeModal from './ComposeModal';

type EmailViewProps = {
  thread: EmailThread | null;
  userId: string;
  userEmail: string;
};

export default function EmailView({ thread, userId, userEmail }: EmailViewProps) {
  const [messages, setMessages] = useState<EmailMessage[]>([]);
  const [summary, setSummary] = useState<string | null>(null);
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [expandedMessages, setExpandedMessages] = useState<Set<string>>(new Set());
  const [category, setCategory] = useState<string | null>(null);
  const [showCompose, setShowCompose] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!thread) return;
    setMessages([]);
    setSummary(thread.summary ?? null);
    setCategory(null);
    setLoading(true);

    const load = async () => {
      try {
        // Use server-side API to bypass RLS issues
        const res = await fetch(`/api/summarize?threadId=${thread.id}`);
        const data = await res.json();

        if (data.messages) {
          setMessages(data.messages);
          // Auto-expand last message
          if (data.messages.length > 0) {
            const lastId = data.messages[data.messages.length - 1].id;
            setExpandedMessages(new Set([lastId]));
          }
        }

        if (data.category?.category) {
          setCategory(data.category.category);
        }
      } catch (err) {
        console.error('Failed to load thread messages:', err);
      }

      setLoading(false);
    };

    load();
  }, [thread?.id]);

  const handleSummarize = async () => {
    if (!thread) return;
    setIsSummarizing(true);
    try {
      const res = await fetch('/api/summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Pass force: true so we skip the cache if we are re-summarizing
        body: JSON.stringify({ threadId: thread.id, action: 'summarize', force: true }),
      });
      const data = await res.json();
      if (data.summary) setSummary(data.summary);
    } catch (err) {
      console.error('Summarize failed:', err);
    } finally {
      setIsSummarizing(false);
    }
  };

  const toggleMessage = (id: string) => {
    setExpandedMessages((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (!thread) {
    return (
      <div className="email-view-empty">
        <div className="empty-placeholder">
          <div className="empty-placeholder-icon">✉️</div>
          <h3>Select an email</h3>
          <p>Choose a thread from the list to read it here</p>
        </div>
      </div>
    );
  }

  const lastMessage = messages[messages.length - 1];
  const catStyle = category ? CATEGORY_COLORS[category] : null;

  return (
    <div className="email-view">
      {/* Thread Header */}
      <div className="email-view-header">
        <div className="email-subject-row">
          <h1 className="email-subject">{thread.subject || '(No Subject)'}</h1>
          {category && catStyle && (
            <span className={`category-badge-lg ${catStyle.bg} ${catStyle.text} ${catStyle.border}`}>
              {CATEGORY_ICONS[category]} {category}
            </span>
          )}
        </div>

        <div className="email-meta-row">
          <div className="email-meta-item">
            <Users size={12} />
            <span>
              {(thread.participants ?? [])
                .slice(0, 3)
                .map((p) => {
                  const email = typeof p === 'string' ? p : p.email;
                  const { name } = formatEmailAddress(email);
                  return name || email.split('@')[0];
                })
                .join(', ')}
              {(thread.participants?.length ?? 0) > 3 && ` +${(thread.participants?.length ?? 0) - 3}`}
            </span>
          </div>
          {thread.last_message_date && (
            <div className="email-meta-item">
              <Calendar size={12} />
              <span>{new Date(thread.last_message_date).toLocaleDateString(undefined, {
                weekday: 'short', year: 'numeric', month: 'short', day: 'numeric'
              })}</span>
            </div>
          )}
          <div className="email-meta-item">
            <Tag size={12} />
            <span>{messages.length} message{messages.length !== 1 ? 's' : ''}</span>
          </div>
        </div>

        {/* Actions */}
        <div className="email-actions">
          <button
            className="action-btn action-btn-primary"
            onClick={handleSummarize}
            disabled={isSummarizing}
            id="summarize-btn"
          >
            {isSummarizing ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Sparkles size={14} />
            )}
            {summary ? 'Re-summarize' : isSummarizing ? 'Summarizing...' : 'AI Summary'}
          </button>
          <button
            className="action-btn"
            onClick={() => setShowCompose(true)}
            id="reply-btn"
          >
            <Reply size={14} />
            Reply
          </button>
        </div>
      </div>

      {/* AI Summary Panel */}
      {summary && (
        <div className="summary-panel" id="summary-panel">
          <div className="summary-header">
            <Sparkles size={14} className="text-violet-400" />
            <span>AI Summary</span>
            <span className="summary-badge">DeepSeek-R1</span>
          </div>
          <div className="summary-content">
            {summary.split('\n').map((line, i) => {
              if (line.startsWith('**') && line.endsWith('**')) {
                return <p key={i} className="summary-heading">{line.replace(/\*\*/g, '')}</p>;
              }
              if (line.startsWith('- ') || line.startsWith('• ')) {
                return <p key={i} className="summary-bullet">• {line.slice(2)}</p>;
              }
              if (line.trim()) return <p key={i} className="summary-text">{line}</p>;
              return null;
            })}
          </div>
        </div>
      )}

      {/* Messages */}
      <div className="messages-list">
        {loading ? (
          <div className="messages-loading">
            <Loader2 size={20} className="animate-spin text-violet-400" />
            <span>Loading messages...</span>
          </div>
        ) : (
          messages.map((msg, index) => {
            const isExpanded = expandedMessages.has(msg.id);
            const isLast = index === messages.length - 1;
            const { name, email } = formatEmailAddress(msg.from_address ?? '');
            const initials = getEmailInitials(name || email);
            const avatarGradient = getAvatarColor(email);
            const bodyText = msg.body_text || htmlToText(msg.body_html ?? '');

            return (
              <div
                key={msg.id}
                className={`message-card ${isLast ? 'message-card-last' : ''}`}
                id={`message-${msg.id}`}
              >
                <div
                  className="message-header"
                  onClick={() => toggleMessage(msg.id)}
                >
                  <div className={`message-avatar bg-gradient-to-br ${avatarGradient}`}>
                    {initials}
                  </div>
                  <div className="message-from-info">
                    <span className="message-from-name">{name || email.split('@')[0]}</span>
                    <span className="message-from-email">{email}</span>
                  </div>
                  <div className="message-header-right">
                    <span className="message-date">
                      {msg.date ? formatRelativeDate(msg.date) : ''}
                    </span>
                    {isExpanded ? (
                      <ChevronUp size={14} className="text-slate-400" />
                    ) : (
                      <ChevronDown size={14} className="text-slate-400" />
                    )}
                  </div>
                </div>

                {isExpanded && (
                  <div className="message-body">
                    {msg.to_addresses?.length > 0 && (
                      <p className="message-to">
                        <span className="message-to-label">To:</span>{' '}
                        {msg.to_addresses.join(', ')}
                      </p>
                    )}
                    <div className="message-text">
                      {msg.body_html ? (
                        <div className="email-iframe-wrapper">
                          <iframe
                            srcDoc={`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  html, body { margin: 0; padding: 12px 16px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 14px; line-height: 1.6; color: #222; background: #fff; word-break: break-word; overflow-wrap: break-word; }
  a { color: #1a73e8; }
  img { max-width: 100%; height: auto; }
  table { max-width: 100%; border-collapse: collapse; }
  pre, code { white-space: pre-wrap; word-break: break-all; max-width: 100%; }
  * { max-width: 100%; box-sizing: border-box; }
  blockquote { border-left: 3px solid #ccc; margin: 8px 0; padding: 4px 12px; color: #555; }
</style>
</head><body>${msg.body_html}</body></html>`}
                            sandbox="allow-same-origin allow-popups"
                            className="email-iframe"
                            onLoad={(e) => {
                              const iframe = e.target as HTMLIFrameElement;
                              const setHeight = () => {
                                try {
                                  const doc = iframe.contentDocument;
                                  if (doc?.body) {
                                    const h = Math.max(doc.documentElement.scrollHeight, doc.body.scrollHeight);
                                    iframe.style.height = (h + 32) + 'px';
                                  }
                                } catch {}
                              };
                              // Set immediately, then again after images load
                              setHeight();
                              setTimeout(setHeight, 400);
                            }}
                            title="Email content"
                          />
                        </div>
                      ) : bodyText ? (
                        <div className="plain-text-body">
                          {bodyText.split('\n').map((line, i) => {
                            const trimmed = line.trim();
                            if (!trimmed) return <div key={i} className="message-spacer" />;
                            // Detect URLs inside the line and make them clickable
                            const urlRegex = /(https?:\/\/[^\s<>]+)/g;
                            const parts = trimmed.split(urlRegex);
                            return (
                              <p key={i} className="message-line">
                                {parts.map((part, j) =>
                                  urlRegex.test(part) ? (
                                    <a key={j} href={part} target="_blank" rel="noopener noreferrer" className="message-link">
                                      {part.length > 60 ? part.slice(0, 60) + '…' : part}
                                    </a>
                                  ) : (
                                    <span key={j}>{part}</span>
                                  )
                                )}
                              </p>
                            );
                          })}
                        </div>
                      ) : (
                        <p className="no-body-text">No message body available</p>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Compose Modal */}
      {showCompose && lastMessage && (
        <ComposeModal
          userId={userId}
          userEmail={userEmail}
          replyTo={lastMessage.from_address ?? ''}
          subject={`Re: ${thread.subject ?? ''}`}
          threadId={thread.id}
          threadContext={messages
            .map((m) => `${m.from_address}: ${m.body_text?.slice(0, 500)}`)
            .join('\n\n')}
          onClose={() => setShowCompose(false)}
          onSent={() => setShowCompose(false)}
        />
      )}
    </div>
  );
}
