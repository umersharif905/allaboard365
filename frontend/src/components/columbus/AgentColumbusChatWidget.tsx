import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useColumbusChat } from '../../hooks/useColumbusChat';
import { useAgentProducts } from '../../hooks/agent/useAgentProducts';
import ColumbusFab from './ColumbusFab';
import ColumbusWindow from './ColumbusWindow';

const OPEN_KEY = 'columbus.agent.open';
const MINIMIZED_KEY = 'columbus.agent.minimized';

// Suggested starter prompts every agent gets. We intentionally do NOT
// auto-generate a "difference between X and Y" prompt — those comparisons
// answer poorly when the two products aren't genuinely comparable.
const AGENT_PROMPTS = [
  'How do I send a quote?',
  'Where do I find my commissions?',
  'What products can I sell?',
];

export default function AgentColumbusChatWidget() {
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

  const isAgent =
    user?.userType === 'Agent' ||
    (user as any)?.currentRole === 'Agent' ||
    (Array.isArray((user as any)?.roles) && (user as any).roles.includes('Agent'));

  const productsQuery = useAgentProducts();
  const products = useMemo(
    () => (isAgent ? productsQuery.data ?? [] : []),
    [isAgent, productsQuery.data],
  );

  // Scope: every product the agent has (individual + group), PLUS the component
  // products inside any bundle. Bundles carry no chunks of their own — their
  // content lives in the included products — so without expanding them Columbus
  // can't answer about anything sold only as part of a bundle.
  const productIds = useMemo(() => {
    const ids: string[] = [];
    for (const p of products) {
      if (p.productId) ids.push(p.productId);
      for (const bp of p.bundleProducts ?? []) {
        if (bp.productId) ids.push(bp.productId);
      }
    }
    return Array.from(
      new Set(ids.filter((id): id is string => typeof id === 'string' && id.trim() !== '')),
    );
  }, [products]);

  const { messages, isStreaming, isOnline, sendMessage, submitReport, submitRating } =
    useColumbusChat(token, { clientApp: 'aab-agent-portal', productIds });

  const firstName = user?.firstName || 'there';

  const greeting = useMemo(
    () =>
      `Hi ${firstName}! I'm Columbus. Ask me about any of your products, how to build a quote, or how to get around the portal.`,
    [firstName],
  );

  const suggestedPrompts = AGENT_PROMPTS;

  if (!isAgent) return null;

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
          memberFirstName={firstName}
          greeting={greeting}
          suggestedPrompts={suggestedPrompts}
          onReport={submitReport}
          onRate={submitRating}
        />
      )}
    </>
  );
}
