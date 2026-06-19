'use client';

import React, { useState, useRef, useEffect } from 'react';
import { Send, Sparkles, Bot, User, ExternalLink, Loader2, X, MessageSquare } from 'lucide-react';

type Source = {
  id: string;
  subject: string | null;
  date: string | null;
  similarity: number;
};

type Message = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  sources?: Source[];
  isStreaming?: boolean;
};

type ChatPanelProps = {
  gmailAccountId: string | null;
  onSelectThread?: (threadId: string) => void;
  onToggle?: () => void;
};

const SUGGESTED_QUERIES = [
  'What are my recent job opportunities?',
  'Summarize my finance emails this week',
  'Any newsletters about AI?',
  'Who emailed me about meetings?',
];

// Renders a line of markdown with inline bold/italic support
function renderInline(text: string, key: string | number): React.ReactNode {
  // Split on **bold** and *italic* patterns
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g);
  return (
    <span key={key}>
      {parts.map((part, i) => {
        if (part.startsWith('**') && part.endsWith('**')) {
          return <strong key={i}>{part.slice(2, -2)}</strong>;
        }
        if (part.startsWith('*') && part.endsWith('*') && part.length > 2) {
          return <em key={i}>{part.slice(1, -1)}</em>;
        }
        return part;
      })}
    </span>
  );
}

function renderMarkdown(text: string): React.ReactNode[] {
  const lines = text.split('\n');
  const nodes: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      nodes.push(<div key={i} style={{ height: 6 }} />);
      i++;
      continue;
    }

    // H1/H2/H3 headers
    if (trimmed.startsWith('### ')) {
      nodes.push(<p key={i} className="chat-bold" style={{ fontSize: 13 }}>{renderInline(trimmed.slice(4), 0)}</p>);
      i++; continue;
    }
    if (trimmed.startsWith('## ') || trimmed.startsWith('# ')) {
      const text = trimmed.replace(/^#{1,2}\s/, '');
      nodes.push(<p key={i} className="chat-bold">{renderInline(text, 0)}</p>);
      i++; continue;
    }

    // Numbered list: "1. text", "2. text"
    const numMatch = trimmed.match(/^(\d+)\.\s+(.+)/);
    if (numMatch) {
      nodes.push(
        <p key={i} className="chat-bullet" style={{ paddingLeft: 4 }}>
          <span style={{ color: 'var(--text-muted)', marginRight: 6, minWidth: 18, display: 'inline-block' }}>{numMatch[1]}.</span>
          {renderInline(numMatch[2], 0)}
        </p>
      );
      i++; continue;
    }

    // Bullet list
    if (trimmed.startsWith('- ') || trimmed.startsWith('• ') || trimmed.startsWith('* ')) {
      const content = trimmed.slice(2);
      nodes.push(<p key={i} className="chat-bullet">• {renderInline(content, 0)}</p>);
      i++; continue;
    }

    // Plain line with potential inline markdown
    nodes.push(<p key={i}>{renderInline(trimmed, 0)}</p>);
    i++;
  }

  return nodes;
}

export default function ChatPanel({ gmailAccountId, onSelectThread, onToggle }: ChatPanelProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const sendMessage = async (query: string = input.trim()) => {
    if (!query || isLoading) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: query,
    };

    const assistantMessage: Message = {
      id: (Date.now() + 1).toString(),
      role: 'assistant',
      content: '',
      sources: [],
      isStreaming: true,
    };

    setMessages((prev) => [...prev, userMessage, assistantMessage]);
    setInput('');
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
    }
    setIsLoading(true);

    try {
      const history = messages.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        content: m.content,
      }));

      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query,
          history,
          gmailAccountId,
        }),
      });

      if (!res.body) throw new Error('No response stream');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let sources: Source[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') break;

          try {
            const parsed = JSON.parse(data);

            // Handle server-side errors sent as SSE events
            if (parsed.error) {
              const errMsg = parsed.error as string;
              let userMsg = 'Something went wrong. Please try again.';
              if (errMsg.includes('404') || errMsg.includes('not found')) {
                userMsg = 'AI model unavailable. Please check your Gemini API key in .env.local.';
              } else if (errMsg.includes('API key') || errMsg.includes('PERMISSION_DENIED') || errMsg.includes('INVALID_ARGUMENT')) {
                userMsg = 'Invalid Gemini API key. Get a valid key from aistudio.google.com (should start with AIza...).';
              } else if (errMsg.includes('quota') || errMsg.includes('RESOURCE_EXHAUSTED')) {
                userMsg = 'Gemini quota exceeded. Please wait a moment and try again.';
              }
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantMessage.id
                    ? { ...m, content: userMsg, isStreaming: false }
                    : m
                )
              );
              break;
            }

            if (parsed.chunk) {
              const chunk = parsed.chunk as string;

              // Extract sources metadata
              if (chunk.startsWith('__SOURCES__') && chunk.includes('__SOURCES_END__')) {
                const jsonStr = chunk
                  .replace('__SOURCES__', '')
                  .replace('__SOURCES_END__', '');
                try {
                  sources = JSON.parse(jsonStr);
                } catch {}
                continue;
              }

              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantMessage.id
                    ? { ...m, content: m.content + chunk, sources }
                    : m
                )
              );
            }
          } catch {}
        }
      }

      // Mark as done streaming
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMessage.id
            ? { ...m, isStreaming: false, sources }
            : m
        )
      );
    } catch (err) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMessage.id
            ? {
                ...m,
                content: 'Sorry, something went wrong. Please try again.',
                isStreaming: false,
              }
            : m
        )
      );
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const clearChat = () => setMessages([]);

  return (
    <div className="chat-panel">
      {/* Header */}
      <div className="chat-header">
        <div className="chat-header-info">
          <div className="chat-icon">
            <Bot size={16} className="text-violet-400" />
          </div>
          <div>
            <h2 className="chat-title">Email Assistant</h2>
            <p className="chat-subtitle">Ask anything about your emails</p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          {messages.length > 0 && (
            <button
              className="chat-clear-btn"
              onClick={clearChat}
              title="Clear conversation"
              id="clear-chat-btn"
            >
              <X size={14} />
            </button>
          )}
          {onToggle && (
            <button
              className="toolbar-btn"
              onClick={onToggle}
              id="toggle-chat-btn"
              title="Hide AI assistant"
            >
              <MessageSquare size={16} />
            </button>
          )}
        </div>
      </div>

      {/* Messages */}
      <div className="chat-messages" id="chat-messages">
        {messages.length === 0 ? (
          <div className="chat-welcome">
            <div className="chat-welcome-icon">
              <Sparkles size={24} className="text-violet-400" />
            </div>
            <h3 className="chat-welcome-title">AI Email Intelligence</h3>
            <p className="chat-welcome-text">
              Ask questions about your emails. Answers are grounded in your actual email data using RAG.
            </p>

            {/* Suggested queries */}
            <div className="suggested-queries">
              {SUGGESTED_QUERIES.map((q, i) => (
                <button
                  key={i}
                  className="suggested-query"
                  onClick={() => sendMessage(q)}
                  id={`suggested-query-${i}`}
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`chat-message ${msg.role === 'user' ? 'chat-message-user' : 'chat-message-assistant'}`}
                id={`chat-msg-${msg.id}`}
              >
                {msg.role === 'assistant' && (
                  <div className="chat-msg-avatar assistant-avatar">
                    <Bot size={12} />
                  </div>
                )}

                <div className="chat-bubble-wrapper">
                  <div className={`chat-bubble ${msg.role === 'user' ? 'bubble-user' : 'bubble-assistant'}`}>
                    {msg.content ? (
                      <div className="chat-content">
                        {renderMarkdown(msg.content)}
                      </div>
                    ) : msg.isStreaming ? (
                      <div className="typing-indicator">
                        <span />
                        <span />
                        <span />
                      </div>
                    ) : null}
                  </div>

                  {/* Sources */}
                  {msg.role === 'assistant' && !msg.isStreaming && msg.sources && msg.sources.length > 0 && (
                    <div className="chat-sources">
                      <p className="sources-label">
                        <Sparkles size={10} /> Sources ({msg.sources.length})
                      </p>
                      {msg.sources.slice(0, 4).map((src, i) => (
                        <button
                          key={src.id}
                          className="source-chip"
                          onClick={() => onSelectThread?.(src.id)}
                          id={`source-${src.id}`}
                          title={src.subject ?? ''}
                        >
                          <span className="source-num">[{i + 1}]</span>
                          <span className="source-subject">
                            {(src.subject ?? 'No Subject').slice(0, 35)}
                            {(src.subject ?? '').length > 35 ? '…' : ''}
                          </span>
                          <ExternalLink size={10} className="source-icon" />
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {msg.role === 'user' && (
                  <div className="chat-msg-avatar user-avatar">
                    <User size={12} />
                  </div>
                )}
              </div>
            ))}
            <div ref={messagesEndRef} />
          </>
        )}
      </div>

      {/* Input */}
      <div className="chat-input-area">
        <div className="chat-input-wrapper">
          <textarea
            ref={inputRef}
            className="chat-input"
            placeholder="Ask about your emails..."
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              // Auto-resize
              e.target.style.height = 'auto';
              e.target.style.height = `${Math.min(e.target.scrollHeight, 150)}px`;
            }}
            onKeyDown={handleKeyDown}
            rows={1}
            id="chat-input"
            disabled={isLoading}
            style={{ minHeight: '44px', resize: 'none', overflowY: 'auto' }}
          />
          <button
            className="chat-send-btn"
            onClick={() => sendMessage()}
            disabled={isLoading || !input.trim()}
            id="chat-send-btn"
          >
            {isLoading ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <Send size={16} />
            )}
          </button>
        </div>
        <p className="chat-hint">Powered by AI · Semantic RAG · Press Enter to send</p>
      </div>
    </div>
  );
}
