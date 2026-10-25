import 'server-only';
import { createHash } from 'node:crypto';
import { AbortManager } from '@/lib/promise-utils';

export const SUPADATA_TIMEOUT_MS = 20_000;
export const SUPADATA_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const SUPADATA_MAX_RESPONSE_CHUNKS = 65_536;
export const SUPADATA_MAX_SEGMENTS = 20_000;
export const SUPADATA_MAX_SEGMENT_CHARS = 16_384;
export const SUPADATA_MAX_TEXT_CHARS = 2_000_000;

type SupadataFailure =
  | { outcome: 'unavailable'; reason: 'captions_unavailable' | 'empty_content' }
  | { outcome: 'dependency_failure'; reason: 'upstream_failure' | 'malformed_content' | 'cancelled' }
  | { outcome: 'unknown_upstream_acceptance'; reason: 'unexpected_job' | 'timeout' | 'cancelled' | 'network_failure' | 'response_limit' };

export interface SupadataMetadata {
  source: 'supadata';
  mode: 'native';
  requestId: string;
  upstreamStatus: number | null;
  billableCredits: number | null;
  billingKind: 'unknown' | 'reported' | 'precharge_estimate';
  latencyMs: number;
  jobIdHash: string | null;
}

export type SupadataTranscriptResult = { metadata: SupadataMetadata } & (
  | { outcome: 'success'; reason: 'native_captions'; segments: { text: string; start: number; duration: number }[];
      language?: string; availableLanguages?: string[] }
  | SupadataFailure
);

/** Cache namespace for future admission/cache callers; language is the requested preference, not returned language. */
export function supadataNativeCacheIdentity(videoId: string, lang?: string): string {
  return JSON.stringify(['supadata', 'native', 'v1', videoId, lang || null]);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class ResponseLimitError extends Error {}
class MalformedBodyError extends Error {}

function cancelBody(response: Response): void {
  void response.body?.cancel().catch(() => {});
}

/** Enforce the actual bytes even when Content-Length is absent or deceptive. */
async function readBoundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const declared = response.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared.trim()) && Number(declared) > SUPADATA_MAX_RESPONSE_BYTES) {
    cancelBody(response);
    throw new ResponseLimitError();
  }
  if (!response.body) throw new MalformedBodyError();
  const reader = response.body.getReader();
  let cancelled = false;
  const cancel = () => {
    if (!cancelled) {
      cancelled = true;
      void reader.cancel().catch(() => {});
    }
  };
  signal.addEventListener('abort', cancel, { once: true });
  let complete = false;
  try {
    // Fixed capacity also bounds bookkeeping for arbitrarily many tiny chunks.
    const bytes = new Uint8Array(SUPADATA_MAX_RESPONSE_BYTES);
    let length = 0;
    let chunks = 0;
    while (true) {
      if (signal.aborted) throw signal.reason;
      const { done, value } = await reader.read();
      if (signal.aborted) throw signal.reason;
      if (done) { complete = true; break; }
      if (++chunks > SUPADATA_MAX_RESPONSE_CHUNKS) throw new ResponseLimitError();
      if (value.byteLength > bytes.length - length) throw new ResponseLimitError();
      bytes.set(value, length);
      length += value.byteLength;
    }
    try { return JSON.parse(new TextDecoder().decode(bytes.subarray(0, length))); }
    catch { throw new MalformedBodyError(); }
  } finally {
    signal.removeEventListener('abort', cancel);
    if (!complete) cancel();
    reader.releaseLock();
  }
}

/** Exactly one native-only attempt. Cancellation bounds local waiting, not vendor work or billing. */
export async function fetchSupadataTranscript(input: {
  videoId: string; lang?: string; apiKey: string; requestId: string; signal?: AbortSignal;
}): Promise<SupadataTranscriptResult> {
  const started = Date.now();
  const metadata: SupadataMetadata = {
    source: 'supadata', mode: 'native', requestId: input.requestId,
    upstreamStatus: null, billableCredits: null, billingKind: 'unknown', latencyMs: 0, jobIdHash: null,
  };
  const failure = (result: SupadataFailure): SupadataTranscriptResult => ({ ...result, metadata });
  if (input.signal?.aborted) return failure({ outcome: 'dependency_failure', reason: 'cancelled' });

  const abortManager = new AbortManager();
  const controller = abortManager.createController('supadata', SUPADATA_TIMEOUT_MS);
  let rejectWaiting: () => void = () => {};
  const interrupted = new Promise<never>((_, reject) => {
    rejectWaiting = () => reject(new Error('interrupted'));
  });
  controller.signal.addEventListener('abort', rejectWaiting, { once: true });
  const onCancel = () => controller.abort();
  input.signal?.addEventListener('abort', onCancel, { once: true });

  console.info(JSON.stringify({ event: 'supadata_transcript_started', source: 'supadata', mode: 'native', requestId: input.requestId }));
  let finished = false;
  const attempt = async (): Promise<SupadataTranscriptResult> => {
    const url = new URL('https://api.supadata.ai/v1/transcript');
    url.searchParams.set('url', `https://www.youtube.com/watch?v=${input.videoId}`);
    url.searchParams.set('mode', 'native');
    url.searchParams.set('text', 'false');
    if (input.lang) url.searchParams.set('lang', input.lang);
    const response = await fetch(url.toString(), {
      method: 'GET', cache: 'no-store', redirect: 'error', signal: controller.signal,
      headers: { 'x-api-key': input.apiKey, 'x-request-id': input.requestId },
    });
    // A late response must not mutate an already-emitted timeout result.
    if (finished) {
      cancelBody(response);
      return failure({ outcome: 'unknown_upstream_acceptance', reason: 'timeout' });
    }
    metadata.upstreamStatus = response.status;
    const header = response.headers.get('x-billable-requests');
    if (header !== null && /^\d+(?:\.\d+)?$/.test(header.trim()) && Number.isFinite(Number(header))) {
      metadata.billableCredits = Number(header);
      metadata.billingKind = response.status === 202 ? 'precharge_estimate' : 'reported';
    }
    if (response.status === 206) {
      cancelBody(response);
      return failure({ outcome: 'unavailable', reason: 'captions_unavailable' });
    }
    if (response.status !== 200 && response.status !== 202) {
      cancelBody(response);
      return failure({ outcome: 'dependency_failure', reason: 'upstream_failure' });
    }

    let body: unknown;
    try { body = await readBoundedJson(response, controller.signal); } catch (error) {
      if (error instanceof ResponseLimitError) return failure({ outcome: 'unknown_upstream_acceptance', reason: 'response_limit' });
      if (controller.signal.aborted || !(error instanceof MalformedBodyError)) throw error;
      return response.status === 202
        ? failure({ outcome: 'unknown_upstream_acceptance', reason: 'unexpected_job' })
        : failure({ outcome: 'dependency_failure', reason: 'malformed_content' });
    }
    if (finished) return failure({ outcome: 'unknown_upstream_acceptance', reason: 'timeout' });
    if (response.status === 202 || (record(body) && 'jobId' in body)) {
      if (record(body) && typeof body.jobId === 'string' && body.jobId.length <= 256) {
        metadata.jobIdHash = createHash('sha256').update(body.jobId).digest('hex');
      }
      // Job headers cannot be treated as final charges even if the status is malformed.
      if (metadata.billableCredits !== null) metadata.billingKind = 'precharge_estimate';
      return failure({ outcome: 'unknown_upstream_acceptance', reason: 'unexpected_job' });
    }
    if (!record(body) || !Array.isArray(body.content)) return failure({ outcome: 'dependency_failure', reason: 'malformed_content' });
    if (body.content.length === 0) return failure({ outcome: 'unavailable', reason: 'empty_content' });
    if (body.content.length > SUPADATA_MAX_SEGMENTS) return failure({ outcome: 'unknown_upstream_acceptance', reason: 'response_limit' });
    const segments: { text: string; start: number; duration: number }[] = [];
    let textChars = 0;
    for (const item of body.content) {
      if (!record(item) || typeof item.text !== 'string'
        || typeof item.offset !== 'number' || !Number.isFinite(item.offset) || item.offset < 0
        || typeof item.duration !== 'number' || !Number.isFinite(item.duration) || item.duration < 0) {
        return failure({ outcome: 'dependency_failure', reason: 'malformed_content' });
      }
      textChars += item.text.length;
      if (item.text.length > SUPADATA_MAX_SEGMENT_CHARS || textChars > SUPADATA_MAX_TEXT_CHARS) {
        return failure({ outcome: 'unknown_upstream_acceptance', reason: 'response_limit' });
      }
      const text = item.text.trim().replace(/^>>\s*/gm, '').trim();
      if (!text) return failure({ outcome: 'dependency_failure', reason: 'malformed_content' });
      segments.push({ text, start: item.offset / 1000, duration: item.duration / 1000 });
    }
    return {
      outcome: 'success', reason: 'native_captions', metadata, segments,
      language: typeof body.lang === 'string' ? body.lang : undefined,
      availableLanguages: Array.isArray(body.availableLangs)
        ? body.availableLangs.filter((lang): lang is string => typeof lang === 'string') : undefined,
    };
  };

  let result: SupadataTranscriptResult;
  try {
    result = await Promise.race([attempt(), interrupted]);
  } catch {
    result = failure({ outcome: 'unknown_upstream_acceptance',
      reason: input.signal?.aborted ? 'cancelled' : controller.signal.aborted ? 'timeout' : 'network_failure' });
  } finally {
    finished = true;
    input.signal?.removeEventListener('abort', onCancel);
    controller.signal.removeEventListener('abort', rejectWaiting);
    abortManager.cleanup();
  }
  metadata.latencyMs = Date.now() - started;
  console.info(JSON.stringify({ event: 'supadata_transcript_completed', ...metadata, outcome: result.outcome, reason: result.reason }));
  return result;
}
