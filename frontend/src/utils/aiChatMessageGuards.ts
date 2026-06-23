/** Narrow assistant union members that carry a `kind` discriminator. */
export function isAssistantMessageWithKind(
  message: { role: string; kind?: string },
  kind: string
): message is { role: 'assistant'; kind: string } {
  return message.role === 'assistant' && message.kind === kind;
}

export function isAssistantStreamingMessage(message: { role: string; kind?: string }): boolean {
  return isAssistantMessageWithKind(message, 'streaming');
}
