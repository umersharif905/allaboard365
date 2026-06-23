import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import type { ColumbusMessage } from '../../types/columbus';
import './ColumbusWidget.css';

interface ColumbusWindowProps {
  messages: ColumbusMessage[];
  isStreaming: boolean;
  isOnline: boolean | null;
  onSend: (text: string) => void;
  onClose: () => void;
  memberFirstName: string;
  suggestedPrompts: string[];
  onReport: (note: string) => Promise<boolean>;
  onRate: (rating: number, messageId?: string) => Promise<boolean>;
  /** Greeting bubble shown before the first message. Defaults to the member copy. */
  greeting?: string;
}

// Show the "How's Columbus doing?" rating prompt after every Nth answer.
const RATING_EVERY = 3;

export default function ColumbusWindow({
  messages,
  isStreaming,
  isOnline,
  onSend,
  onClose,
  memberFirstName,
  suggestedPrompts,
  onReport,
  onRate,
  greeting,
}: ColumbusWindowProps) {
  const navigate = useNavigate();
  const [input, setInput] = useState('');
  const [mounted, setMounted] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Report-a-wrong-answer modal
  const [reportOpen, setReportOpen] = useState(false);
  const [reportText, setReportText] = useState('');
  const [reportStatus, setReportStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');

  // Periodic rating prompt
  const [ratingHandledAt, setRatingHandledAt] = useState(-1);
  const [ratingThanks, setRatingThanks] = useState(false);
  const [hoverStar, setHoverStar] = useState(0);

  // Count completed (non-streaming, non-error) assistant answers.
  const answers = messages.filter((m) => m.role === 'assistant' && m.content && !m.streaming && !m.error);
  const answerCount = answers.length;
  const lastAnswerId = answers.length ? answers[answers.length - 1].messageId : undefined;
  const showRating =
    !isStreaming &&
    answerCount > 0 &&
    answerCount % RATING_EVERY === 0 &&
    ratingHandledAt !== answerCount;

  const handleRate = async (rating: number) => {
    setRatingHandledAt(answerCount);
    setRatingThanks(true);
    await onRate(rating, lastAnswerId);
    setTimeout(() => setRatingThanks(false), 2500);
  };

  const submitReport = async () => {
    const note = reportText.trim();
    if (!note || reportStatus === 'sending') return;
    setReportStatus('sending');
    const ok = await onReport(note);
    setReportStatus(ok ? 'sent' : 'error');
    if (ok) {
      setReportText('');
      setTimeout(() => { setReportOpen(false); setReportStatus('idle'); }, 1800);
    }
  };

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isStreaming]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  if (!mounted) return null;

  const online = isOnline !== false;

  const submit = () => {
    const text = input.trim();
    if (!text || isStreaming) return;
    onSend(text);
    setInput('');
  };

  const handleKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const showSuggestions = messages.length === 0 && !isStreaming;
  const showGreeting = messages.length === 0;

  return createPortal(
    <div className="columbus-widget">
      <div className="columbus-chat columbus-chat--open" role="dialog" aria-label="Columbus chat">
        <div className="columbus-chat__header">
          <div className="columbus-chat__header-left">
            <img
              src="/images/columbus.webp"
              alt="Columbus"
              className="columbus-chat__header-avatar"
            />
            <div>
              <span className="columbus-chat__header-name">Columbus</span>
              <span className="columbus-chat__header-status">
                <span className="columbus-chat__status-dot" />
                {online ? 'Online' : 'Offline'}
              </span>
            </div>
          </div>
          <button
            className="columbus-chat__close"
            onClick={onClose}
            aria-label="Close chat"
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <path
                d="M15 5L5 15M5 5l10 10"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        <div ref={bodyRef} className="columbus-chat__body">
          {showGreeting && (
            <div className="columbus-msg columbus-msg--bot">
              <img
                src="/images/columbus.webp"
                alt=""
                className="columbus-msg__avatar"
              />
              <div className="columbus-msg__bubble">
                {greeting ??
                  `Hi ${memberFirstName}! I'm Columbus. Ask me anything about your plan — coverage, copays, claims, what to do at the doctor, anything.`}
              </div>
            </div>
          )}

          {messages.map((msg, i) => {
            const isUser = msg.role === 'user';
            const isError = !!msg.error;
            const cls = [
              'columbus-msg',
              isUser ? 'columbus-msg--user' : 'columbus-msg--bot',
              isError ? 'columbus-msg--error' : '',
            ]
              .filter(Boolean)
              .join(' ');
            return (
              <div key={i} className={cls}>
                {!isUser && (
                  <img
                    src="/images/columbus.webp"
                    alt=""
                    className="columbus-msg__avatar"
                  />
                )}
                <div className="columbus-msg__body">
                  <div className="columbus-msg__bubble">
                    {msg.content ? (
                      isUser ? (
                        <span style={{ whiteSpace: 'pre-wrap' }}>{msg.content}</span>
                      ) : (
                        <ReactMarkdown
                          components={{
                            a: ({ ...props }) => (
                              <a
                                {...props}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="columbus-link"
                              />
                            ),
                            p: ({ ...props }) => (
                              <p {...props} style={{ margin: '0 0 0.5em 0' }} />
                            ),
                            ul: ({ ...props }) => (
                              <ul
                                {...props}
                                style={{ paddingLeft: '1.25em', margin: '0 0 0.5em 0' }}
                              />
                            ),
                            ol: ({ ...props }) => (
                              <ol
                                {...props}
                                style={{ paddingLeft: '1.25em', margin: '0 0 0.5em 0' }}
                              />
                            ),
                            li: ({ ...props }) => (
                              <li {...props} style={{ marginBottom: '0.25em' }} />
                            ),
                          }}
                        >
                          {msg.content}
                        </ReactMarkdown>
                      )
                    ) : msg.streaming ? (
                      <div className="columbus-typing">
                        <span className="columbus-typing__dot" />
                        <span className="columbus-typing__dot" />
                        <span className="columbus-typing__dot" />
                      </div>
                    ) : null}
                    {msg.streaming && msg.content && <span className="columbus-cursor" />}
                  </div>
                  {!isUser && !msg.streaming && msg.actions && msg.actions.length > 0 && (
                    <div className="columbus-action-btns">
                      {msg.actions.map((action) => (
                        <button
                          key={action.target}
                          className="columbus-action-btn"
                          onClick={() => {
                            if (action.target.startsWith('http')) {
                              window.open(action.target, '_blank', 'noopener,noreferrer');
                            } else {
                              navigate(action.target);
                              onClose();
                            }
                          }}
                        >
                          <svg width="13" height="13" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                            <path d="M7 4l6 6-6 6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                          {action.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          <div ref={endRef} />
        </div>

        <div className="columbus-chat__footer">
          {showSuggestions && suggestedPrompts.length > 0 && (
            <div className="columbus-suggestions">
              {suggestedPrompts.map((prompt) => (
                <button
                  key={prompt}
                  className="columbus-suggestions__btn"
                  onClick={() => onSend(prompt)}
                  disabled={isStreaming}
                >
                  {prompt}
                </button>
              ))}
            </div>
          )}

          {ratingThanks && (
            <div className="columbus-rating columbus-rating--thanks">Thanks for the feedback! 🐢</div>
          )}
          {showRating && !ratingThanks && (
            <div className="columbus-rating">
              <span className="columbus-rating__label">How's Columbus doing?</span>
              <div className="columbus-rating__stars" onMouseLeave={() => setHoverStar(0)}>
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    type="button"
                    className={`columbus-rating__star ${n <= hoverStar ? 'is-active' : ''}`}
                    onMouseEnter={() => setHoverStar(n)}
                    onClick={() => handleRate(n)}
                    aria-label={`Rate ${n} out of 5`}
                  >
                    ★
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="columbus-rating__dismiss"
                onClick={() => setRatingHandledAt(answerCount)}
                aria-label="Dismiss rating"
              >
                Not now
              </button>
            </div>
          )}

          <div className="columbus-chat__input-row">
            <input
              ref={inputRef}
              type="text"
              className="columbus-chat__input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKey}
              placeholder={
                isStreaming
                  ? 'Columbus is thinking...'
                  : !online
                  ? 'Columbus is offline'
                  : 'Ask Columbus about your plan...'
              }
              maxLength={2000}
              disabled={!online}
            />
            <button
              className="columbus-chat__send"
              onClick={submit}
              disabled={isStreaming || !input.trim() || !online}
              aria-label="Send message"
            >
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                <path
                  d="M3 10l7-7m0 0l7 7m-7-7v14"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  transform="rotate(90, 10, 10)"
                />
              </svg>
            </button>
          </div>
          <div className="columbus-chat__footer-meta">
            <span className="columbus-chat__disclaimer">
              Columbus explains plan details — not medical advice.
            </span>
            <button
              type="button"
              className="columbus-report-link"
              onClick={() => { setReportOpen(true); setReportStatus('idle'); }}
            >
              Wrong answer?
            </button>
          </div>
        </div>

        {reportOpen && (
          <div className="columbus-report" role="dialog" aria-label="Report a wrong answer">
            <div className="columbus-report__card">
              <div className="columbus-report__header">
                <span>Report a wrong answer</span>
                <button
                  type="button"
                  className="columbus-report__close"
                  onClick={() => setReportOpen(false)}
                  aria-label="Close"
                >
                  ×
                </button>
              </div>
              {reportStatus === 'sent' ? (
                <p className="columbus-report__sent">Thanks — we've sent this to the MightyWELL team. 🐢</p>
              ) : (
                <>
                  <p className="columbus-report__hint">
                    Tell us what was wrong or missing. Your chat transcript is included automatically.
                  </p>
                  <textarea
                    className="columbus-report__textarea"
                    value={reportText}
                    onChange={(e) => setReportText(e.target.value)}
                    placeholder="What did Columbus get wrong?"
                    maxLength={2000}
                    rows={4}
                    autoFocus
                  />
                  {reportStatus === 'error' && (
                    <p className="columbus-report__error">Couldn't send — please try again.</p>
                  )}
                  <div className="columbus-report__actions">
                    <button
                      type="button"
                      className="columbus-report__cancel"
                      onClick={() => setReportOpen(false)}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="columbus-report__submit"
                      onClick={submitReport}
                      disabled={!reportText.trim() || reportStatus === 'sending'}
                    >
                      {reportStatus === 'sending' ? 'Sending…' : 'Send report'}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
