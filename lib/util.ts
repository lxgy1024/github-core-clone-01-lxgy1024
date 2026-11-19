// Small shared helpers: fixed timestamps (deterministic state), ids, JSON bodies.
import type { IncomingMessage, ServerResponse } from 'node:http';

// The scenario the sealed suite drives is fixed and public (kit sdk/conformance/wire.ts):
// the token names the viewer "adaiversen" (id 1000); the only other login the suite uses is
// the stranger "olgabauer". Repos created by the token belong to the viewer; any other owner
// in a path is a foreign owner and answers 404, never 403.
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const STRANGER_LOGIN = 'olgabauer';
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';

// Every timestamp the forge emits is this fixed instant, so two runs on the same instance
// leave the same state. Commit objects use the matching epoch below.
export const FIXED_ISO = '2026-11-14T06:30:00.000Z';
export const FIXED_EPOCH = 1763092200; // 2026-11-14T06:30:00Z
export const ZERO_OID = '0000000000000000000000000000000000000000';

let requestCounter = 0;
export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

export function json(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'x-github-request-id': nextRequestId(),
    ...extraHeaders,
  });
  res.end(text);
}

export function jsonError(res: ServerResponse, status: number, message: string, extraHeaders: Record<string, string> = {}): void {
  json(res, status, { message }, extraHeaders);
}

export async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export function parseJsonBody(buf: Buffer): { ok: true; value: unknown } | { ok: false; error: string } {
  if (buf.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(buf.toString('utf8')) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'invalid JSON' };
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function b64encode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

export function b64decode(text: string): Buffer {
  return Buffer.from(text.replace(/[\r\n\t ]+/g, ''), 'base64');
}

export function wrapBase64(text: string): string {
  const lines: string[] = [];
  for (let i = 0; i < text.length; i += 60) lines.push(text.slice(i, i + 60));
  return lines.join('\n');
}

export function escapeHtmlAttr(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}
