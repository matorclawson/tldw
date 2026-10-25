import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  fetchSupadataTranscript, SUPADATA_TIMEOUT_MS, supadataNativeCacheIdentity,
  SUPADATA_MAX_RESPONSE_BYTES, SUPADATA_MAX_RESPONSE_CHUNKS, SUPADATA_MAX_SEGMENTS, SUPADATA_MAX_SEGMENT_CHARS, SUPADATA_MAX_TEXT_CHARS,
} from '@/lib/supadata-transcript-provider';

const upstream = vi.fn();
const input = { videoId: 'abcdefghijk', apiKey: 'secret-test-key', requestId: 'test-request' };
const nativeBody = {
  content: [
    { text: '>> Early caption.', offset: 120, duration: 250 },
    { text: 'Later caption.', offset: 8150, duration: 1200 },
  ],
  lang: 'es', availableLangs: ['es'],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', upstream);
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

function expectOneNativeCall() {
  expect(upstream).toHaveBeenCalledTimes(1);
  expect(new URL(upstream.mock.calls[0][0]).searchParams.get('mode')).toBe('native');
}

function completion() {
  return vi.mocked(console.info).mock.calls.map(([line]) => JSON.parse(String(line)))
    .find(event => event.event === 'supadata_transcript_completed');
}

it('fetches native captions once and converts documented millisecond units, including small offsets', async () => {
  upstream.mockResolvedValue(Response.json(nativeBody, { headers: { 'x-billable-requests': '1' } }));
  const result = await fetchSupadataTranscript({ ...input, lang: 'en' });
  expect(result).toMatchObject({
    outcome: 'success', language: 'es', availableLanguages: ['es'],
    segments: [
      { text: 'Early caption.', start: 0.12, duration: 0.25 },
      { text: 'Later caption.', start: 8.15, duration: 1.2 },
    ],
    metadata: { source: 'supadata', mode: 'native', upstreamStatus: 200, billableCredits: 1, billingKind: 'reported', requestId: 'test-request' },
  });
  expect(upstream).toHaveBeenCalledTimes(1);
  const [url, options] = upstream.mock.calls[0];
  expect(new URL(url).searchParams.get('mode')).toBe('native');
  expect(new URL(url).searchParams.get('text')).toBe('false');
  expect(new URL(url).searchParams.get('lang')).toBe('en');
  expect(options).toMatchObject({ redirect: 'error', cache: 'no-store', headers: { 'x-request-id': 'test-request' } });
});

it.each([
  [206, { error: 'transcript-unavailable' }, 'unavailable', 'captions_unavailable'],
  [206, nativeBody, 'unavailable', 'captions_unavailable'],
  [200, { content: [] }, 'unavailable', 'empty_content'],
  [500, { error: 'internal-error', details: 'sensitive upstream detail' }, 'dependency_failure', 'upstream_failure'],
  [429, {}, 'dependency_failure', 'upstream_failure'],
  [404, {}, 'dependency_failure', 'upstream_failure'],
  [202, { jobId: 'private-job-id' }, 'unknown_upstream_acceptance', 'unexpected_job'],
  [200, { jobId: 'private-job-id', ...nativeBody }, 'unknown_upstream_acceptance', 'unexpected_job'],
])('classifies HTTP %s intentionally, keeping billed failures visible', async (status, body, outcome, reason) => {
  upstream.mockResolvedValue(Response.json(body, { status, headers: { 'x-billable-requests': '3' } }));
  expect(await fetchSupadataTranscript(input)).toMatchObject({ outcome, reason, metadata: { upstreamStatus: status, billableCredits: 3 } });
  expectOneNativeCall();
  expect(completion()).toMatchObject({ outcome, reason, billableCredits: 3, requestId: input.requestId, latencyMs: expect.any(Number) });
  const logs = JSON.stringify(vi.mocked(console.info).mock.calls);
  for (const secret of [input.apiKey, 'private-job-id', 'sensitive upstream detail', 'Early caption.']) expect(logs).not.toContain(secret);
  if (reason === 'unexpected_job') expect(completion()).toMatchObject({ billingKind: 'precharge_estimate', jobIdHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
});

it.each([null, {}, { content: 'plain text' }, { transcript: nativeBody.content },
  { content: [null] }, { content: [{ text: 'hello', offset: '120', duration: 250 }] },
  { content: [{ text: 'hello', offset: -1, duration: 250 }] },
  { content: [{ text: 'hello', offset: 1 }] },
  { content: [{ text: '  >> ', offset: 0, duration: 10 }] },
])('rejects malformed content without retry: %j', async body => {
  upstream.mockResolvedValue(Response.json(body));
  expect(await fetchSupadataTranscript(input)).toMatchObject({ outcome: 'dependency_failure', reason: 'malformed_content' });
  expectOneNativeCall();
});

it.each([200, 202])('handles invalid JSON for HTTP %s without losing billing metadata', async status => {
  upstream.mockResolvedValue(new Response('not json secret', { status, headers: { 'x-billable-requests': '1' } }));
  expect(await fetchSupadataTranscript(input)).toMatchObject({
    outcome: status === 202 ? 'unknown_upstream_acceptance' : 'dependency_failure',
    metadata: { billableCredits: 1, upstreamStatus: status },
  });
  expectOneNativeCall();
});

it.each([null, '', '-1', 'NaN', 'Infinity', 'garbage', '0', '2.5'])('records billing header %j without inferring zero', async header => {
  upstream.mockResolvedValue(Response.json(nativeBody, { headers: header === null ? {} : { 'x-billable-requests': header } }));
  const known = header === '0' || header === '2.5';
  expect(await fetchSupadataTranscript(input)).toMatchObject({ metadata: {
    billableCredits: known ? Number(header) : null, billingKind: known ? 'reported' : 'unknown',
  } });
  expectOneNativeCall();
});

it.each(['headers', 'body'])('bounds waiting for stalled %s, aborts locally, and never resubmits', async phase => {
  vi.useFakeTimers();
  upstream.mockImplementation(() => phase === 'headers' ? new Promise(() => {}) : Promise.resolve(new Response(
    new ReadableStream({ pull: () => new Promise(() => {}) }),
    { headers: { 'x-billable-requests': '1' } },
  )));
  const pending = fetchSupadataTranscript(input);
  await vi.advanceTimersByTimeAsync(SUPADATA_TIMEOUT_MS);
  expect(await pending).toMatchObject({ outcome: 'unknown_upstream_acceptance', reason: 'timeout', metadata: {
    upstreamStatus: phase === 'headers' ? null : 200, billableCredits: phase === 'headers' ? null : 1,
    latencyMs: SUPADATA_TIMEOUT_MS,
  } });
  expect(upstream.mock.calls[0][1].signal.aborted).toBe(true);
  expectOneNativeCall();
  expect(vi.getTimerCount()).toBe(0);
});

it('treats transport failures as unknown acceptance and redacts thrown details', async () => {
  upstream.mockRejectedValue(new Error('secret-test-key cookie=secret'));
  expect(await fetchSupadataTranscript(input)).toMatchObject({ outcome: 'unknown_upstream_acceptance', reason: 'network_failure' });
  expectOneNativeCall();
  expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain('secret');
});

it('cancels in-flight waiting without starting another request', async () => {
  const controller = new AbortController();
  upstream.mockImplementation(() => new Promise(() => {}));
  const pending = fetchSupadataTranscript({ ...input, signal: controller.signal });
  controller.abort();
  expect(await pending).toMatchObject({ outcome: 'unknown_upstream_acceptance', reason: 'cancelled' });
  expectOneNativeCall();
});

it('does not submit already-cancelled requests', async () => {
  expect(await fetchSupadataTranscript({ ...input, signal: AbortSignal.abort() })).toMatchObject({ outcome: 'dependency_failure', reason: 'cancelled' });
  expect(upstream).not.toHaveBeenCalled();
});

it('publishes native-mode cache identity with requested language isolation', () => {
  expect(supadataNativeCacheIdentity(input.videoId, 'en')).toBe('["supadata","native","v1","abcdefghijk","en"]');
  expect(supadataNativeCacheIdentity(input.videoId)).toBe('["supadata","native","v1","abcdefghijk",null]');
  expect(supadataNativeCacheIdentity(input.videoId, 'es')).not.toBe(supadataNativeCacheIdentity(input.videoId, 'en'));
});

it.each([200, 202])('refuses excessive declared bytes before reading HTTP %s, cancels and retains billing uncertainty', async status => {
  const cancel = vi.fn();
  const body = new ReadableStream({ cancel });
  upstream.mockResolvedValue(new Response(body, { status, headers: {
    'content-length': String(SUPADATA_MAX_RESPONSE_BYTES + 1), 'x-billable-requests': '1',
  } }));
  expect(await fetchSupadataTranscript(input)).toMatchObject({
    outcome: 'unknown_upstream_acceptance', reason: 'response_limit',
    metadata: { billableCredits: 1, billingKind: status === 202 ? 'precharge_estimate' : 'reported' },
  });
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(body.locked).toBe(false);
  expectOneNativeCall();
});

it.each([undefined, '1', 'invalid'])('enforces streamed byte ceiling with Content-Length=%j and stops further reads', async declared => {
  const cancel = vi.fn();
  let pulls = 0;
  const chunk = new Uint8Array(64 * 1024).fill(32);
  const body = new ReadableStream({ pull(controller) { pulls++; controller.enqueue(chunk); }, cancel }, { highWaterMark: 0 });
  upstream.mockResolvedValue(new Response(body, { headers: {
    ...(declared === undefined ? {} : { 'content-length': declared }), 'x-billable-requests': '2',
  } }));
  expect(await fetchSupadataTranscript(input)).toMatchObject({ outcome: 'unknown_upstream_acceptance', reason: 'response_limit',
    metadata: { billableCredits: 2, billingKind: 'reported' } });
  expect(pulls).toBe(SUPADATA_MAX_RESPONSE_BYTES / chunk.byteLength + 1);
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(body.locked).toBe(false);
  expectOneNativeCall();
});

it('refuses an oversized single chunk before decoding or parsing it', async () => {
  const cancel = vi.fn();
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(SUPADATA_MAX_RESPONSE_BYTES + 1)); }, cancel });
  upstream.mockResolvedValue(new Response(body));
  expect(await fetchSupadataTranscript(input)).toMatchObject({ outcome: 'unknown_upstream_acceptance', reason: 'response_limit' });
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(body.locked).toBe(false);
  expectOneNativeCall();
});

it.each([0, 1])('bounds repeated %s-byte chunks even when the byte budget cannot terminate the stream', async size => {
  let pulls = 0;
  const cancel = vi.fn();
  const body = new ReadableStream({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(size)); }, cancel }, { highWaterMark: 0 });
  upstream.mockResolvedValue(new Response(body));
  expect(await fetchSupadataTranscript(input)).toMatchObject({ outcome: 'unknown_upstream_acceptance', reason: 'response_limit' });
  expect(pulls).toBe(SUPADATA_MAX_RESPONSE_CHUNKS + 1);
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(body.locked).toBe(false);
  expectOneNativeCall();
});

it('does not wait indefinitely for an uncooperative body cancellation', async () => {
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(SUPADATA_MAX_RESPONSE_BYTES + 1)); },
    cancel: () => new Promise(() => {}),
  });
  upstream.mockResolvedValue(new Response(body));
  expect(await fetchSupadataTranscript(input)).toMatchObject({ outcome: 'unknown_upstream_acceptance', reason: 'response_limit' });
  expect(body.locked).toBe(false);
  expectOneNativeCall();
});

it('counts encoded bytes rather than characters', async () => {
  upstream.mockResolvedValue(Response.json({ ...nativeBody, padding: 'é'.repeat(SUPADATA_MAX_RESPONSE_BYTES / 2) }));
  expect(await fetchSupadataTranscript(input)).toMatchObject({ outcome: 'unknown_upstream_acceptance', reason: 'response_limit' });
  expectOneNativeCall();
});

it.each(['segments', 'segment text', 'aggregate text'])('bounds %s before normalized output can expand', async dimension => {
  const item = { text: 'x', offset: 0, duration: 1 };
  const content = dimension === 'segments' ? Array(SUPADATA_MAX_SEGMENTS + 1).fill(item)
    : dimension === 'segment text' ? [{ ...item, text: 'x'.repeat(SUPADATA_MAX_SEGMENT_CHARS + 1) }]
      : Array(Math.floor(SUPADATA_MAX_TEXT_CHARS / 10_000) + 1).fill({ ...item, text: 'x'.repeat(10_000) });
  upstream.mockResolvedValue(Response.json({ content }, { headers: { 'x-billable-requests': '1' } }));
  expect(await fetchSupadataTranscript(input)).toMatchObject({ outcome: 'unknown_upstream_acceptance', reason: 'response_limit',
    metadata: { billableCredits: 1 } });
  expectOneNativeCall();
});

it('accepts a segment at the text limit and JSON split across UTF-8 byte boundaries', async () => {
  const text = 'é'.repeat(SUPADATA_MAX_SEGMENT_CHARS);
  const encoded = new TextEncoder().encode(JSON.stringify({ content: [{ text, offset: 0, duration: 1000 }] }));
  const body = new ReadableStream({ start(controller) {
    for (let i = 0; i < encoded.length; i += 101) controller.enqueue(encoded.subarray(i, i + 101));
    controller.close();
  } });
  upstream.mockResolvedValue(new Response(body));
  expect(await fetchSupadataTranscript(input)).toMatchObject({ outcome: 'success', segments: [{ text, start: 0, duration: 1 }] });
  expect(body.locked).toBe(false);
  expectOneNativeCall();
});

it.each(['timeout', 'cancelled'])('cancels a stalled body and releases its lock on %s', async reason => {
  vi.useFakeTimers();
  const cancel = vi.fn();
  const body = new ReadableStream({ pull: () => new Promise(() => {}), cancel });
  const controller = new AbortController();
  upstream.mockResolvedValue(new Response(body, { headers: { 'x-billable-requests': '1' } }));
  const pending = fetchSupadataTranscript({ ...input, signal: controller.signal });
  await vi.advanceTimersByTimeAsync(0);
  if (reason === 'timeout') await vi.advanceTimersByTimeAsync(SUPADATA_TIMEOUT_MS);
  else controller.abort();
  expect(await pending).toMatchObject({ outcome: 'unknown_upstream_acceptance', reason, metadata: { billableCredits: 1 } });
  await Promise.resolve();
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(body.locked).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
  expectOneNativeCall();
});

it.each([206, 429, 500])('cancels an unread HTTP %s body', async status => {
  const cancel = vi.fn();
  const body = new ReadableStream({ cancel });
  upstream.mockResolvedValue(new Response(body, { status }));
  await fetchSupadataTranscript(input);
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(body.locked).toBe(false);
  expectOneNativeCall();
});

it('treats a body transport failure as unknown acceptance and releases the reader', async () => {
  const body = new ReadableStream({ pull(controller) { controller.error(new SyntaxError('transport failure')); } });
  upstream.mockResolvedValue(new Response(body));
  expect(await fetchSupadataTranscript(input)).toMatchObject({ outcome: 'unknown_upstream_acceptance', reason: 'network_failure' });
  expect(body.locked).toBe(false);
  expectOneNativeCall();
});

it('cancels a response arriving after cancellation without mutating the emitted metadata', async () => {
  let deliver!: (response: Response) => void;
  upstream.mockImplementation(() => new Promise<Response>(resolve => { deliver = resolve; }));
  const controller = new AbortController();
  const pending = fetchSupadataTranscript({ ...input, signal: controller.signal });
  controller.abort();
  const result = await pending;
  const cancel = vi.fn();
  deliver(new Response(new ReadableStream({ cancel }), { headers: { 'x-billable-requests': '3' } }));
  await Promise.resolve();
  await Promise.resolve();
  expect(result).toMatchObject({ outcome: 'unknown_upstream_acceptance', reason: 'cancelled', metadata: { upstreamStatus: null, billableCredits: null } });
  expect(cancel).toHaveBeenCalledTimes(1);
  expectOneNativeCall();
});
