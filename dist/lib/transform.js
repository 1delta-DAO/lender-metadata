export function normalizeToDisplayData(upstream) {
    return {
        items: upstream.items.map((x) => ({
            id: String(x.id),
            label: x.name,
            group: x.category ?? null
        }))
    };
}
