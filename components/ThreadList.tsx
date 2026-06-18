'use client';

import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import {
  formatRelativeDate,
  CATEGORY_COLORS,
  CATEGORY_ICONS,
  getEmailInitials,
  getAvatarColor,
  formatEmailAddress,
} from '@/lib/utils';
import type { EmailThread } from '@/lib/supabase';
import { Search, Loader2 } from 'lucide-react';

type ThreadListProps = {
  userId: string;
  selectedCategory: string;
  selectedThreadId: string | null;
  onSelectThread: (thread: EmailThread) => void;
  gmailAccountId: string | null;
};

export default function ThreadList({
  userId,
  selectedCategory,
  selectedThreadId,
  onSelectThread,
  gmailAccountId,
}: ThreadListProps) {
  const [threads, setThreads] = useState<(EmailThread & { category?: string })[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<(EmailThread & { category?: string })[] | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 30;

  const loadThreads = useCallback(async () => {
    if (!gmailAccountId) return;
    setLoading(true);

    let query = supabase
      .from('email_threads')
      .select(`
        *,
        email_categories(category, confidence)
      `)
      .eq('gmail_account_id', gmailAccountId)
      .order('last_message_date', { ascending: false })
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

    const { data, error } = await query;
    if (error) {
      console.error('Error loading threads:', error);
      setLoading(false);
      return;
    }

    const enriched = (data ?? []).map((t: EmailThread & { email_categories?: Array<{category: string; confidence: number}> }) => ({
      ...t,
      category: t.email_categories?.[0]?.category ?? undefined,
    })) as (EmailThread & { category?: string })[];

    setThreads((prev) => (page === 0 ? enriched : [...prev, ...enriched]));
    setLoading(false);
  }, [gmailAccountId, page]);

  useEffect(() => {
    setPage(0);
    setThreads([]);
    loadThreads();
  }, [gmailAccountId, selectedCategory]);

  useEffect(() => {
    if (page > 0) loadThreads();
  }, [page]);

  // Real-time subscription
  useEffect(() => {
    if (!gmailAccountId) return;
    const channel = supabase
      .channel('thread-changes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'email_threads' },
        () => { setPage(0); loadThreads(); }
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [gmailAccountId]);

  // Semantic search
  const handleSearch = async (q: string) => {
    if (!q.trim()) {
      setSearchResults(null);
      return;
    }
    setIsSearching(true);
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: q,
          history: [],
          gmailAccountId,
          searchOnly: true,
        }),
      });
      // For search, we just filter the visible list by subject/summary
      const filtered = threads.filter(
        (t) =>
          t.subject?.toLowerCase().includes(q.toLowerCase()) ||
          t.summary?.toLowerCase().includes(q.toLowerCase()) ||
          t.participants?.some((p) =>
            (typeof p === 'string' ? p : p.email)
              .toLowerCase()
              .includes(q.toLowerCase())
          )
      );
      setSearchResults(filtered);
    } catch {
      setSearchResults(null);
    } finally {
      setIsSearching(false);
    }
  };

  const displayThreads = searchResults !== null ? searchResults : threads;

  const filteredThreads =
    selectedCategory === 'All'
      ? displayThreads
      : displayThreads.filter((t) => {
          // Support both exact match and case-insensitive match
          const cat = t.category?.toLowerCase().trim();
          const sel = selectedCategory.toLowerCase().trim();
          return cat === sel;
        });

  // Count per category for badge display
  const categoryCounts = threads.reduce((acc, t) => {
    if (t.category) {
      acc[t.category] = (acc[t.category] || 0) + 1;
    }
    return acc;
  }, {} as Record<string, number>);

  return (
    <div className="thread-list-container">
      {/* Search */}
      <div className="search-bar">
        <Search size={14} className="search-icon" />
        <input
          type="text"
          placeholder="Search emails..."
          className="search-input"
          value={searchQuery}
          id="email-search-input"
          onChange={(e) => {
            setSearchQuery(e.target.value);
            handleSearch(e.target.value);
          }}
        />
        {isSearching && <Loader2 size={14} className="animate-spin text-slate-400" />}
      </div>

      {/* Thread count */}
      <div className="thread-count">
        {filteredThreads.length} thread{filteredThreads.length !== 1 ? 's' : ''}
        {selectedCategory !== 'All' && ` · ${selectedCategory}`}
        {selectedCategory !== 'All' && filteredThreads.length === 0 && threads.length > 0 && (
          <span className="thread-count-hint"> — click Sync to categorize</span>
        )}
      </div>

      {/* Thread items */}
      <div className="thread-items" id="thread-list">
        {loading && page === 0 ? (
          <div className="loading-state">
            {[...Array(8)].map((_, i) => (
              <div key={i} className="thread-skeleton">
                <div className="skeleton-avatar" />
                <div className="skeleton-content">
                  <div className="skeleton-line skeleton-line-short" />
                  <div className="skeleton-line" />
                  <div className="skeleton-line skeleton-line-xs" />
                </div>
              </div>
            ))}
          </div>
        ) : filteredThreads.length === 0 ? (
          <div className="empty-state">
            <span className="empty-icon">📭</span>
            <p>No emails found</p>
            <span className="empty-sub">Try syncing or a different filter</span>
          </div>
        ) : (
          <>
            {filteredThreads.map((thread) => {
              const fromParticipant =
                thread.participants?.[thread.participants.length - 1];
              const email =
                typeof fromParticipant === 'string'
                  ? fromParticipant
                  : fromParticipant?.email ?? '';
              const { name } = formatEmailAddress(email);
              const initials = getEmailInitials(name || email);
              const avatarGradient = getAvatarColor(email);
              const catStyle = thread.category
                ? CATEGORY_COLORS[thread.category]
                : null;
              const isSelected = thread.id === selectedThreadId;

              return (
                <button
                  key={thread.id}
                  className={`thread-item ${isSelected ? 'selected' : ''}`}
                  onClick={() => onSelectThread(thread)}
                  id={`thread-${thread.id}`}
                >
                  {/* Avatar */}
                  <div
                    className={`thread-avatar bg-gradient-to-br ${avatarGradient}`}
                  >
                    {initials}
                  </div>

                  {/* Content */}
                  <div className="thread-content">
                    <div className="thread-row-top">
                      <span className="thread-sender">
                        {name || email.split('@')[0]}
                      </span>
                      <span className="thread-date">
                        {formatRelativeDate(thread.last_message_date)}
                      </span>
                    </div>
                    <p className="thread-subject">
                      {thread.subject || '(No Subject)'}
                    </p>
                    {thread.summary && (
                      <p className="thread-summary">
                        {thread.summary.slice(0, 100)}
                        {thread.summary.length > 100 ? '…' : ''}
                      </p>
                    )}
                    {thread.category && catStyle && (
                      <span
                        className={`category-badge ${catStyle.bg} ${catStyle.text} ${catStyle.border}`}
                      >
                        {CATEGORY_ICONS[thread.category]} {thread.category}
                      </span>
                    )}
                  </div>
                </button>
              );
            })}

            {/* Load more */}
            {!searchResults && filteredThreads.length >= (page + 1) * PAGE_SIZE && (
              <button
                className="load-more-btn"
                onClick={() => setPage((p) => p + 1)}
                id="load-more-btn"
              >
                {loading ? <Loader2 size={14} className="animate-spin" /> : 'Load more'}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
