import type { BusEvent } from '@manta/bus';
import { formatTimestamp, truncate } from './format.js';

export function formatTailEvent(event: BusEvent): string {
  const ts = formatTimestamp(event.ts);
  const type = event.type.padEnd(16);
  const payload = formatPayload(event.payload);
  return `[${ts}] ${type}  ${truncate(payload, 80)}`;
}

export function formatTailEventRaw(event: BusEvent): string {
  return JSON.stringify(event);
}

function formatPayload(payload: unknown): string {
  if (payload == null) return '';
  if (typeof payload === 'string') return payload;
  if (typeof payload === 'object') {
    return Object.entries(payload as Record<string, unknown>)
      .map(([k, v]) => {
        if (typeof v === 'string') return `${k}="${v}"`;
        if (typeof v === 'number' || typeof v === 'boolean') return `${k}=${v}`;
        return `${k}=${JSON.stringify(v)}`;
      })
      .join(' ');
  }
  return String(payload);
}
