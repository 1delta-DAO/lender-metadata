import type { Upstream } from '#lib/schema';
import type { DisplayData } from '#lib/types';

export function normalizeToDisplayData(upstream: Upstream): DisplayData {
  return {
    items: upstream.items.map((x) => ({
      id: String(x.id),
      label: x.name,
      group: x.category ?? null
    }))
  };
}
