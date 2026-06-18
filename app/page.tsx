'use client';

import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import type { EmailThread } from '@/lib/supabase';
import Sidebar from '@/components/Sidebar';
import ThreadList from '@/components/ThreadList';
import EmailView from '@/components/EmailView';
import ChatPanel from '@/components/ChatPanel';
import { Loader2, PenSquare, X, CheckCircle, AlertCircle, MessageSquare } from 'lucide-react';
import ComposeModal from '@/components/ComposeModal';

type Toast = {
  id: string;
  type: 'success' | 'error';
  message: string;
};

export default function HomePage() {
  // Auth
  const [user, setUser] = useState<{ id: string; email: string | undefined } | null>(null);
  const [loading, setLoading] = useState(true); // start true — prevents auth screen flash before session loads

  // Gmail connection
  const [connectedEmail, setConnectedEmail] = useState<string | null>(null);
  const [gmailAccountId, setGmailAccountId] = useState<string | null>(null);
  const [lastSynced, setLastSynced] = useState<string | null>(null);
  const [threadCount, setThreadCount] = useState(0);

  // UI State
  const [selectedCategory, setSelectedCategory] = useState('All');
  const [selectedThread, setSelectedThread] = useState<EmailThread | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState<number | undefined>();
  const [showCompose, setShowCompose] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [chatOpen, setChatOpen] = useState(true);

  const showToast = useCallback((type: 'success' | 'error', message: string) => {
    const id = Date.now().toString();
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }, []);

  // Initialize auth
  useEffect(() => {
    const init = async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (session?.user) {
          setUser({ id: session.user.id, email: session.user.email });
          setLoading(false); // unblock UI immediately after session check
          loadGmailAccount(session.user.id); // load Gmail info in background (non-blocking)
        } else {
          setLoading(false); // no session → show auth screen
        }
      } catch (err) {
        console.error('Auth init error:', err);
        setLoading(false); // always unblock on error
      }
    };

    init();

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (event === 'SIGNED_IN' && session?.user) {
        setUser({ id: session.user.id, email: session.user.email });
        loadGmailAccount(session.user.id);
      } else if (event === 'SIGNED_OUT') {
        setUser(null);
        setConnectedEmail(null);
        setGmailAccountId(null);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  // Handle URL params after Gmail OAuth callback
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);

    if (params.get('connected') === 'true' && user) {
      window.history.replaceState({}, '', '/');
      showToast('success', 'Gmail connected successfully!');

      // Retry up to 6x — the OAuth callback write to Supabase may not be done yet
      const retryLoad = async (userId: string, attempts = 0) => {
        const found = await loadGmailAccount(userId);
        if (!found && attempts < 5) {
          setTimeout(() => retryLoad(userId, attempts + 1), 1500);
        }
      };
      retryLoad(user.id);
    }

    if (params.get('error')) {
      showToast('error', `Connection failed: ${params.get('error')}`);
      window.history.replaceState({}, '', '/');
    }
  }, [user]);


  const loadGmailAccount = async (userId: string): Promise<boolean> => {
    try {
      // Use server-side API to bypass any RLS/session timing issues on Render
      const res = await fetch(`/api/gmail/sync?userId=${userId}`);
      if (!res.ok) return false;
      const data = await res.json();

      if (data.connected && data.emailAddress) {
        setConnectedEmail(data.emailAddress);
        setLastSynced(data.lastSynced ?? null);
        setThreadCount(data.threadCount ?? 0);

        // Also get the gmail_account id for queries (still needed for ThreadList)
        const { data: acct } = await supabase
          .from('gmail_accounts')
          .select('id')
          .eq('user_id', userId)
          .single();
        if (acct?.id) setGmailAccountId(acct.id);
        return true;
      }
      return false;
    } catch (err) {
      console.error('loadGmailAccount error:', err);
      return false;
    }
  };

  const handleGoogleSignIn = async () => {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || window.location.origin;
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: appUrl,
        scopes: 'email profile',
      },
    });
  };

  const handleConnectGmail = () => {
    window.location.href = '/api/gmail/connect';
  };

  const handleSync = async (mode: 'full' | 'incremental') => {
    if (!user || isSyncing) return;
    setIsSyncing(true);
    setSyncProgress(0);

    try {
      const res = await fetch('/api/gmail/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.id, mode }),
      });
      const data = await res.json();

      if (data.success) {
        showToast('success', `Synced ${data.synced} emails, processed ${data.processed} threads`);
        await loadGmailAccount(user.id);
      } else {
        showToast('error', data.error ?? 'Sync failed');
      }
    } catch (err) {
      showToast('error', 'Network error during sync');
    } finally {
      setIsSyncing(false);
      setSyncProgress(undefined);
    }
  };

  const handleLogout = async () => {
    // Clear all local state immediately for instant UI feedback
    setUser(null);
    setConnectedEmail(null);
    setGmailAccountId(null);
    setSelectedThread(null);
    setThreadCount(0);
    setToasts([]);

    // Sign out from Supabase
    await supabase.auth.signOut();

    // Hard navigation clears all session cookies + localStorage on Render
    window.location.href = '/';
  };

  const handleSelectThreadFromChat = useCallback(
    (threadId: string) => {
      // Trigger thread selection (find the thread and select it)
      supabase
        .from('email_threads')
        .select('*')
        .eq('id', threadId)
        .single()
        .then(({ data }) => {
          if (data) setSelectedThread(data as EmailThread);
        });
    },
    []
  );

  // ─── Config guard — show helpful screen when env vars are stubs ──
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const isConfigured =
    supabaseUrl.startsWith('https://') &&
    !supabaseUrl.includes('YOUR_PROJECT');

  if (!isConfigured) {
    return (
      <main className="auth-screen">
        <div className="auth-card" style={{ textAlign: 'left', maxWidth: 460 }}>
          <div className="auth-logo" style={{ margin: '0 0 16px' }}>⚙️</div>
          <h1 className="auth-title" style={{ textAlign: 'left' }}>Setup Required</h1>
          <p className="auth-subtitle" style={{ textAlign: 'left' }}>
            Fill in your <code style={{ background: 'rgba(139,92,246,0.2)', padding: '1px 6px', borderRadius: 4, fontSize: 12 }}>.env.local</code> file to get started.
          </p>
          <div className="auth-features">
            {[
              { icon: '🟢', label: 'NEXT_PUBLIC_SUPABASE_URL', hint: 'From Supabase → Settings → API' },
              { icon: '🟢', label: 'NEXT_PUBLIC_SUPABASE_ANON_KEY', hint: 'From Supabase → Settings → API' },
              { icon: '🟢', label: 'SUPABASE_SERVICE_ROLE_KEY', hint: 'From Supabase → Settings → API' },
              { icon: '🔵', label: 'GOOGLE_CLIENT_ID / SECRET', hint: 'From Google Cloud Console → Credentials' },
              { icon: '🟣', label: 'GEMINI_API_KEY', hint: 'From Google AI Studio → aistudio.google.com' },
              { icon: '🟠', label: 'NVIDIA_NIM_API_KEY', hint: 'From build.nvidia.com → Get API Key' },
            ].map((item) => (
              <div key={item.label} className="auth-feature">
                <span className="auth-feature-icon">{item.icon}</span>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 12, color: 'var(--text-primary)' }}>{item.label}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{item.hint}</div>
                </div>
              </div>
            ))}
          </div>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
            After filling in credentials, the server will auto-reload.
          </p>
        </div>
      </main>
    );
  }

  // ─── Loading ────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="auth-screen">
        <Loader2 size={32} className="animate-spin text-violet-400" />
      </div>
    );
  }

  // ─── Auth Screen ─────────────────────────────────────────────
  if (!user) {
    return (
      <main className="auth-screen">
        <div className="auth-card">
          <div className="auth-logo">✉️</div>
          <h1 className="auth-title">GmailAI</h1>
          <p className="auth-subtitle">
            Your inbox, supercharged with AI. Summarize threads, search semantically, and chat with your emails.
          </p>

          <div className="auth-features">
            <div className="auth-feature">
              <span className="auth-feature-icon">🧠</span>
              <span>AI summaries & smart categorization</span>
            </div>
            <div className="auth-feature">
              <span className="auth-feature-icon">🔍</span>
              <span>Semantic search powered by NVIDIA NIM</span>
            </div>
            <div className="auth-feature">
              <span className="auth-feature-icon">💬</span>
              <span>RAG chat grounded in your emails</span>
            </div>
            <div className="auth-feature">
              <span className="auth-feature-icon">✍️</span>
              <span>AI-drafted replies with Gemini</span>
            </div>
          </div>

          <button
            className="auth-google-btn"
            onClick={handleGoogleSignIn}
            id="google-signin-btn"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
            </svg>
            Continue with Google
          </button>

          <div className="auth-divider">POWERED BY</div>
          <div style={{ display: 'flex', justifyContent: 'center', gap: 16, flexWrap: 'wrap' }}>
            {['Llama 3.1', 'NVIDIA NIM', 'pgvector', 'Next.js 16'].map((tech) => (
              <span key={tech} style={{
                fontSize: 11, color: 'var(--text-muted)',
                padding: '3px 8px',
                border: '1px solid var(--border-subtle)',
                borderRadius: 999,
              }}>
                {tech}
              </span>
            ))}
          </div>
        </div>
      </main>
    );
  }

  // ─── Main App ─────────────────────────────────────────────────
  // Build dynamic grid columns based on panel visibility
  const gridCols = [
    sidebarOpen ? '240px' : '0px',
    '1fr',
    chatOpen ? '380px' : '0px',
  ].join(' ');

  return (
    <div
      className="app-shell"
      style={{ gridTemplateColumns: gridCols }}
    >
      {/* Sidebar */}
      <div className={`sidebar-panel ${sidebarOpen ? 'sidebar-panel-open' : 'sidebar-panel-closed'}`}>
        <Sidebar
          userId={user.id}
          connectedEmail={connectedEmail}
          lastSynced={lastSynced}
          threadCount={threadCount}
          selectedCategory={selectedCategory}
          onCategoryChange={setSelectedCategory}
          onSync={handleSync}
          isSyncing={isSyncing}
          syncProgress={syncProgress}
          onConnectGmail={handleConnectGmail}
          onLogout={handleLogout}
          onToggle={() => setSidebarOpen(false)}
        />
      </div>

      {/* Center: Thread List + Email View */}
      <div style={{ display: 'flex', overflow: 'hidden', flex: 1, minWidth: 0 }}>
        {/* Thread List */}
        <ThreadList
          userId={user.id}
          selectedCategory={selectedCategory}
          selectedThreadId={selectedThread?.id ?? null}
          onSelectThread={setSelectedThread}
          gmailAccountId={gmailAccountId}
        />

        {/* Email View — takes full height, no toolbar above it */}
        <div style={{ flex: 1, overflow: 'hidden', position: 'relative', minWidth: 0 }}>
          <EmailView
            thread={selectedThread}
            userId={user.id}
            userEmail={user.email ?? ''}
          />

          {/* Compose FAB */}
          <button
            className="compose-fab"
            onClick={() => setShowCompose(true)}
            id="compose-fab"
          >
            <PenSquare size={14} />
            Compose
          </button>

          {/* Floating button to re-open sidebar when hidden */}
          {!sidebarOpen && (
            <button
              className="floating-toggle-btn floating-toggle-left"
              onClick={() => setSidebarOpen(true)}
              title="Show sidebar"
              id="show-sidebar-btn"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="3" y1="6" x2="21" y2="6"/>
                <line x1="3" y1="12" x2="21" y2="12"/>
                <line x1="3" y1="18" x2="21" y2="18"/>
              </svg>
            </button>
          )}

          {/* Floating button to re-open chat when hidden */}
          {!chatOpen && (
            <button
              className="floating-toggle-btn floating-toggle-right"
              onClick={() => setChatOpen(true)}
              title="Show AI assistant"
              id="show-chat-btn"
            >
              <MessageSquare size={16} />
            </button>
          )}
        </div>
      </div>

      {/* Right: Chat Panel */}
      <div className={`chat-panel-wrapper ${chatOpen ? 'chat-panel-wrapper-open' : 'chat-panel-wrapper-closed'}`}>
        <ChatPanel
          gmailAccountId={gmailAccountId}
          onSelectThread={handleSelectThreadFromChat}
          onToggle={() => setChatOpen(false)}
        />
      </div>

      {/* Global Compose Modal */}
      {showCompose && (
        <ComposeModal
          userId={user.id}
          userEmail={user.email ?? ''}
          onClose={() => setShowCompose(false)}
          onSent={() => {
            setShowCompose(false);
            showToast('success', 'Email sent!');
          }}
        />
      )}

      {/* Toasts */}
      <div style={{ position: 'fixed', bottom: 20, right: 20, display: 'flex', flexDirection: 'column', gap: 8, zIndex: 300 }}>
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast-${toast.type}`}>
            {toast.type === 'success' ? (
              <CheckCircle size={14} className="text-emerald-400" />
            ) : (
              <AlertCircle size={14} className="text-red-400" />
            )}
            <span>{toast.message}</span>
            <button
              style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', marginLeft: 8 }}
              onClick={() => setToasts((prev) => prev.filter((t) => t.id !== toast.id))}
            >
              <X size={12} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
