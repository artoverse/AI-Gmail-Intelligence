'use client';

import { useState, useEffect } from 'react';
import { X, Send, Sparkles, Loader2, Mail } from 'lucide-react';

type ComposeModalProps = {
  userId: string;
  userEmail: string;
  replyTo?: string;
  subject?: string;
  threadId?: string;
  threadContext?: string;
  onClose: () => void;
  onSent: () => void;
};

export default function ComposeModal({
  userId,
  userEmail,
  replyTo = '',
  subject = '',
  threadId,
  threadContext,
  onClose,
  onSent,
}: ComposeModalProps) {
  const [to, setTo] = useState(replyTo);
  const [emailSubject, setEmailSubject] = useState(subject);
  const [body, setBody] = useState('');
  const [instruction, setInstruction] = useState('');
  const [isDrafting, setIsDrafting] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Auto-draft on mount if it's a reply
  useEffect(() => {
    if (replyTo && threadId) {
      setInstruction('Write a professional acknowledgment reply');
    }
  }, [replyTo, threadId]);

  const handleDraftWithAI = async () => {
    if (!instruction.trim()) return;
    setIsDrafting(true);
    setError(null);

    try {
      const res = await fetch('/api/summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          threadId: threadId || '',
          action: threadId ? 'draft_reply' : 'draft_compose',
          instruction: instruction.trim(),
          userEmail,
        }),
      });
      const data = await res.json();
      if (data.draft) {
        setBody(data.draft);
        // For new emails, auto-fill subject if returned
        if (!threadId && data.subject && !emailSubject) {
          setEmailSubject(data.subject);
        }
      } else {
        setError('Could not generate draft. Try again.');
      }
    } catch (err) {
      setError('Draft generation failed');
    } finally {
      setIsDrafting(false);
    }
  };


  const handleSend = async () => {
    if (!to || !emailSubject || !body) {
      setError('Please fill in all fields');
      return;
    }
    setIsSending(true);
    setError(null);

    try {
      const res = await fetch('/api/gmail/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          to,
          subject: emailSubject,
          emailBody: body,
          threadId,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setSuccess(true);
        setTimeout(onSent, 1000);
      } else {
        setError(data.error || 'Send failed');
      }
    } catch (err) {
      setError('Failed to send email');
    } finally {
      setIsSending(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-container" id="compose-modal">
        {/* Header */}
        <div className="modal-header">
          <div className="modal-title">
            <Mail size={16} className="text-violet-400" />
            <span>{threadId ? 'Reply to Thread' : 'Compose Email'}</span>
          </div>
          <button className="modal-close-btn" onClick={onClose} id="close-compose-btn">
            <X size={16} />
          </button>
        </div>

        {/* Form */}
        <div className="modal-body">
          <div className="form-field">
            <label className="field-label">To</label>
            <input
              type="email"
              className="field-input"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="recipient@example.com"
              id="compose-to"
            />
          </div>

          <div className="form-field">
            <label className="field-label">Subject</label>
            <input
              type="text"
              className="field-input"
              value={emailSubject}
              onChange={(e) => setEmailSubject(e.target.value)}
              placeholder="Email subject"
              id="compose-subject"
            />
          </div>

          {/* AI Draft Section — works for both new compose and replies */}
          <div className="ai-draft-section">
            <label className="field-label">
              {threadId ? 'AI Reply Instruction' : 'AI Compose Prompt'}
            </label>
            <div className="ai-draft-row">
              <input
                type="text"
                className="field-input flex-1"
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                placeholder={
                  threadId
                    ? 'e.g. Accept the meeting, ask for reschedule...'
                    : 'e.g. Write a follow-up to the product team about Q3 launch delay'
                }
                id="draft-instruction"
              />
              <button
                className="draft-btn"
                onClick={handleDraftWithAI}
                disabled={isDrafting || !instruction.trim()}
                id="ai-draft-btn"
              >
                {isDrafting ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Sparkles size={14} />
                )}
                {isDrafting ? 'Drafting...' : 'Draft with AI'}
              </button>
            </div>
          </div>


          <div className="form-field">
            <label className="field-label">Message</label>
            <textarea
              className="field-textarea"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Write your message..."
              rows={10}
              id="compose-body"
            />
          </div>

          {error && (
            <div className="error-banner" id="compose-error">
              {error}
            </div>
          )}
          {success && (
            <div className="success-banner" id="compose-success">
              ✓ Email sent successfully!
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="modal-footer">
          <button className="modal-cancel-btn" onClick={onClose} id="cancel-compose-btn">
            Cancel
          </button>
          <button
            className="modal-send-btn"
            onClick={handleSend}
            disabled={isSending || success}
            id="send-email-btn"
          >
            {isSending ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Send size={14} />
            )}
            {isSending ? 'Sending...' : 'Send Email'}
          </button>
        </div>
      </div>
    </div>
  );
}
