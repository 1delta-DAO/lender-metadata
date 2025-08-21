import { DisplayDataSchema } from '#lib/schema';
import type { DisplayData } from '#lib/types';

export type FetchDisplayDataResult =
  | { notModified: true; etag?: string; data?: undefined }
  | { notModified: false; etag?: string; data: DisplayData };

/**
 * Fetches the dataset once, validates it, and returns typed data.
 * If you pass an `etag`, it will send If-None-Match and surface 304 as { notModified: true }.
 */
export async function fetchDisplayData(url: string, opts?: { etag?: string }): Promise<FetchDisplayDataResult> {
  const headers = new Headers();
  if (opts?.etag) headers.set('If-None-Match', opts.etag);

  const res = await fetch(url, { headers, cache: 'no-store' });
  if (res.status === 304) {
    return { notModified: true, etag: opts?.etag };
  }
  if (!res.ok) {
    throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  }

  const raw = await res.json();
  const parsed = DisplayDataSchema.parse(raw);
  const etag = res.headers.get('ETag') ?? undefined;
  return { notModified: false, etag, data: parsed };
}
