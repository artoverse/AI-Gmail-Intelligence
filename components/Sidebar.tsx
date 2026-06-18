'use client';

import { useState, useEffect } from 'react';
import { RefreshCw, Mail, LogOut, ChevronRight, Wifi, Tag, Menu, Loader2 } from 'lucide-react';
import { CATEGORY_ICONS, CATEGORY_COLORS, formatRelativeDate } from '@/lib/utils';

const CATEGORIES = ['All', 'Newsletter', 'Job', 'Finance', 'Notification', 'Personal', 'Work', 'Other'] as const;

type SidebarProps = {
  userId: string | null;
  connectedEmail: string | null;
  lastSynced: string | null;
  threadCount: number;
  selectedCategory: string;
  onCategoryChange: (cat: string) => void;
  onSync: (mode: 'full' | 'incremental') => void;
  isSyncing: boolean;
  syncProgress?: number;
  onConnectGmail: () => void;
  onLogout: () => void;
  onToggle: () => void;
};

export default function Sidebar({
  userId,
  connectedEmail,
  lastSynced,
  threadCount,
  selectedCategory,
  onCategoryChange,
  onSync,
  isSyncing,
  syncProgress,
  onConnectGmail,
  onLogout,
  onToggle,
}: SidebarProps) {
  const [showSyncMenu, setShowSyncMenu] = useState(false);
  const [isCategorizing, setIsCategorizing] = useState(false);
  const [catStatus, setCatStatus] = useState<{ total: number; categorized: number } | null>(null);

  // Load categorization progress on mount
  useEffect(() => {
    if (!userId || !connectedEmail) return;
    fetch(`/api/gmail/categorize?userId=${userId}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.total !== undefined) {
          setCatStatus({ total: data.total, categorized: data.categorized });
        }
      })
      .catch(() => {});
  }, [userId, connectedEmail, isCategorizing]);

  const handleCategorize = async () => {
    if (!userId || isCategorizing) return;
    setIsCategorizing(true);
    try {
      const res = await fetch('/api/gmail/categorize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId }),
      });
      const data = await res.json();
      if (data.success) {
        setCatStatus((prev) => ({
          total: prev?.total ?? 0,
          categorized: (prev?.categorized ?? 0) + (data.ruleCategorized ?? 0) + (data.llmCategorized ?? 0),
        }));
        // If there's more to categorize, auto-run again after a short delay
        if (data.remaining > 0) {
          setTimeout(() => handleCategorize(), 2000);
        }
      }
    } catch (err) {
      console.error('Categorize error:', err);
    } finally {
      setIsCategorizing(false);
    }
  };

  const uncategorizedCount = catStatus ? catStatus.total - catStatus.categorized : null;
  const allCategorized = catStatus && uncategorizedCount !== null && uncategorizedCount <= 0;

  return (
    <aside className="sidebar">
      {/* Header with logo + hamburger */}
      <div className="sidebar-header">
        <div className="logo">
          <div className="logo-icon">
            <Mail size={18} />
          </div>
          <span className="logo-text">GmailAI</span>
        </div>
        <button
          className="toolbar-btn"
          onClick={onToggle}
          id="toggle-sidebar-btn"
          title="Hide sidebar"
          style={{ marginLeft: 'auto' }}
        >
          <Menu size={16} />
        </button>
      </div>

      {/* Account Status */}
      <div className="account-card">
        {connectedEmail ? (
          <>
            <div className="account-info">
              <div className="account-avatar">
                {connectedEmail[0].toUpperCase()}
              </div>
              <div className="account-details">
                <span className="account-email" title={connectedEmail}>
                  {connectedEmail.length > 22
                    ? connectedEmail.slice(0, 19) + '...'
                    : connectedEmail}
                </span>
                <span className="account-meta">
                  <Wifi size={10} className="text-emerald-400" />
                  {threadCount.toLocaleString()} threads
                </span>
              </div>
            </div>
            {lastSynced && (
              <p className="last-synced">
                Synced {formatRelativeDate(lastSynced)}
              </p>
            )}
          </>
        ) : (
          <button className="connect-btn" onClick={onConnectGmail} id="connect-gmail-btn">
            <Mail size={14} />
            Connect Gmail
          </button>
        )}
      </div>

      {/* Sync Button */}
      {connectedEmail && (
        <div className="sync-container">
          <button
            className={`sync-btn ${isSyncing ? 'syncing' : ''}`}
            onClick={() => setShowSyncMenu(!showSyncMenu)}
            disabled={isSyncing}
            id="sync-btn"
          >
            <RefreshCw size={14} className={isSyncing ? 'animate-spin' : ''} />
            {isSyncing ? `Syncing${syncProgress ? ` (${syncProgress})` : '...'}` : 'Sync Emails'}
            <ChevronRight size={12} className={`ml-auto transition-transform ${showSyncMenu ? 'rotate-90' : ''}`} />
          </button>
          {showSyncMenu && !isSyncing && (
            <div className="sync-menu" id="sync-menu">
              <button
                className="sync-option"
                onClick={() => { onSync('incremental'); setShowSyncMenu(false); }}
                id="sync-incremental-btn"
              >
                <span className="sync-option-icon">⚡</span>
                <div>
                  <div className="sync-option-title">Incremental</div>
                  <div className="sync-option-desc">New emails only</div>
                </div>
              </button>
              <button
                className="sync-option"
                onClick={() => { onSync('full'); setShowSyncMenu(false); }}
                id="sync-full-btn"
              >
                <span className="sync-option-icon">🔄</span>
                <div>
                  <div className="sync-option-title">Full Sync</div>
                  <div className="sync-option-desc">All emails (slower)</div>
                </div>
              </button>
            </div>
          )}

          {/* Categorize button — shown when there are uncategorized threads */}
          {connectedEmail && !allCategorized && (
            <button
              className={`sync-btn ${isCategorizing ? 'syncing' : ''}`}
              onClick={handleCategorize}
              disabled={isCategorizing || isSyncing}
              id="categorize-btn"
              style={{ marginTop: 6 }}
            >
              {isCategorizing ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Tag size={14} />
              )}
              {isCategorizing
                ? 'Categorizing...'
                : uncategorizedCount !== null && uncategorizedCount > 0
                  ? `Categorize (${uncategorizedCount} left)`
                  : 'Categorize Emails'}
            </button>
          )}
          {allCategorized && (
            <p style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'center', marginTop: 4 }}>
              ✅ All {catStatus?.total} emails categorized
            </p>
          )}
        </div>
      )}

      {/* Category Navigation */}
      <nav className="category-nav">
        <p className="nav-label">Categories</p>
        {CATEGORIES.map((cat) => (
          <button
            key={cat}
            className={`category-btn ${selectedCategory === cat ? 'active' : ''}`}
            onClick={() => onCategoryChange(cat)}
            id={`category-${cat.toLowerCase()}-btn`}
          >
            <span className="category-btn-icon">
              {cat === 'All' ? '📬' : CATEGORY_ICONS[cat] ?? '📧'}
            </span>
            <span className="category-btn-label">{cat}</span>
            {selectedCategory === cat && (
              <ChevronRight size={12} className="ml-auto opacity-60" />
            )}
          </button>
        ))}
      </nav>

      {/* Logout */}
      <div className="sidebar-footer">
        <button className="logout-btn" onClick={onLogout} id="logout-btn">
          <LogOut size={14} />
          Sign Out
        </button>
      </div>
    </aside>
  );
}
