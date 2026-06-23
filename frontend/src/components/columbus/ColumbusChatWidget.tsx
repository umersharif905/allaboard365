import { useEffect, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useColumbusChat } from '../../hooks/useColumbusChat';
import ColumbusFab from './ColumbusFab';
import ColumbusWindow from './ColumbusWindow';

const OPEN_KEY = 'columbus.open';
const MINIMIZED_KEY = 'columbus.minimized';

const SUGGESTED_PROMPTS = [
  'Where are my ID cards?',
  'What plan do I have?',
  'How does telemedicine work?',
];

export default function ColumbusChatWidget() {
  const { user } = useAuth();

  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(OPEN_KEY) === '1';
    } catch {
      return false;
    }
  });

  const [minimized, setMinimized] = useState(() => {
    try {
      return localStorage.getItem(MINIMIZED_KEY) === '1';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(OPEN_KEY, open ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [open]);

  useEffect(() => {
    try {
      localStorage.setItem(MINIMIZED_KEY, minimized ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [minimized]);

  const handleMinimize = () => {
    setOpen(false);
    setMinimized(true);
  };

  const token =
    typeof window !== 'undefined' ? localStorage.getItem('accessToken') : null;

  const { messages, isStreaming, isOnline, sendMessage, submitReport, submitRating } =
    useColumbusChat(token);

  const isMember =
    user?.userType === 'Member' ||
    (user as any)?.currentRole === 'Member' ||
    (Array.isArray((user as any)?.roles) && (user as any).roles.includes('Member'));

  if (!isMember) return null;

  return (
    <>
      <ColumbusFab
        onClick={() => setOpen(true)}
        isOnline={isOnline}
        isOpen={open}
        isMinimized={minimized}
        onMinimize={handleMinimize}
        onRestore={() => setMinimized(false)}
      />
      {open && !minimized && (
        <ColumbusWindow
          messages={messages}
          isStreaming={isStreaming}
          isOnline={isOnline}
          onSend={sendMessage}
          onClose={() => setOpen(false)}
          memberFirstName={user?.firstName || 'there'}
          suggestedPrompts={SUGGESTED_PROMPTS}
          onReport={submitReport}
          onRate={submitRating}
        />
      )}
    </>
  );
}
