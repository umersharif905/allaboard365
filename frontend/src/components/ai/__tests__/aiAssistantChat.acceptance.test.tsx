import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AiChatComposer } from '../AiChatComposer';
import { AiChatMarkdown } from '../../commissions/ai/AiChatMarkdown';

describe('AI assistant chat acceptance (frontend)', () => {
  describe('AC1 multiline input — Enter does not send', () => {
    it('does not call onSend when Enter is pressed in the composer', () => {
      const onSend = vi.fn();
      const onPromptChange = vi.fn();
      render(
        <AiChatComposer
          prompt="line1"
          onPromptChange={onPromptChange}
          onSend={onSend}
          sendDisabled={false}
        />
      );
      const textarea = screen.getByRole('textbox');
      fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });
      expect(onSend).not.toHaveBeenCalled();
    });
  });

  describe('AC2 Send only via button', () => {
    it('calls onSend when Send is clicked', () => {
      const onSend = vi.fn();
      render(
        <AiChatComposer
          prompt="hello"
          onPromptChange={vi.fn()}
          onSend={onSend}
          sendDisabled={false}
        />
      );
      fireEvent.click(screen.getByRole('button', { name: /send/i }));
      expect(onSend).toHaveBeenCalledTimes(1);
    });

    it('does not call onSend when Send is disabled', () => {
      const onSend = vi.fn();
      render(
        <AiChatComposer
          prompt=""
          onPromptChange={vi.fn()}
          onSend={onSend}
          sendDisabled={true}
        />
      );
      fireEvent.click(screen.getByRole('button', { name: /send/i }));
      expect(onSend).not.toHaveBeenCalled();
    });
  });

  describe('AC7 markdown rendering', () => {
    it('renders bold and preserves single newlines as hard breaks', () => {
      const { container } = render(
        <AiChatMarkdown>{'**Bold** line\nSecond line'}</AiChatMarkdown>
      );
      expect(container.querySelector('strong')?.textContent).toBe('Bold');
      const html = container.innerHTML;
      expect(html).toMatch(/<br\s*\/?>/i);
    });
  });
});
