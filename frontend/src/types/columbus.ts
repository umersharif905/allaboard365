export interface ColumbusAction {
  label: string;
  target: string;
}

export interface ColumbusMessage {
  role: 'user' | 'assistant';
  content: string;
  streaming?: boolean;
  error?: boolean;
  /** Columbus answer id, used to attribute a 1-5 rating back to the chunks that fed it. */
  messageId?: string;
  actions?: ColumbusAction[];
}
