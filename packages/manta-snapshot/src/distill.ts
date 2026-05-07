import type { z } from 'zod';
import type { MessageSchema, OpenFileSchema } from './schema';

type Message = z.infer<typeof MessageSchema>;
type OpenFile = z.infer<typeof OpenFileSchema>;

export interface DistillInput {
  messages: Message[];
  openFiles: OpenFile[];
  maxRecentMessages: number;
  allowedPaths?: string[];
}

export interface DistillOutput {
  recentMessages: Message[];
  openFiles: OpenFile[];
}

export function distillContext(input: DistillInput): DistillOutput {
  if (!Number.isInteger(input.maxRecentMessages) || input.maxRecentMessages <= 0) {
    throw new Error(
      `distillContext: maxRecentMessages must be a positive integer (got ${input.maxRecentMessages})`,
    );
  }

  const recentMessages =
    input.messages.length > input.maxRecentMessages
      ? input.messages.slice(input.messages.length - input.maxRecentMessages)
      : [...input.messages];

  const openFiles = input.allowedPaths
    ? input.openFiles.filter((f) => input.allowedPaths!.some((p) => f.path.startsWith(p)))
    : [...input.openFiles];

  return { recentMessages, openFiles };
}
