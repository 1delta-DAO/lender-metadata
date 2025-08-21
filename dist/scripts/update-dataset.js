import { UpstreamSchema } from '#lib/schema';
import { normalizeToDisplayData } from '#lib/transform';
import { sha256Hex } from '#lib/hash';
import { writeTextIfChanged } from '#lib/io';
const UPSTREAM_URL = process.env.UPSTREAM_URL || 'https://example.com/api/labels'; // <-- set in CI
async function fetchUpstream() {
    const res = await fetch(UPSTREAM_URL, { headers: { Accept: 'application/json' } });
    if (!res.ok)
        throw new Error(`Upstream fetch failed: ${res.status} ${res.statusText}`);
    return res.json();
}
async function main() {
    const upstreamUnknown = await fetchUpstream();
    // Validate upstream (adjust schema as needed)
    const upstream = UpstreamSchema.parse(upstreamUnknown);
    // Normalize to your public shape
    const display = normalizeToDisplayData(upstream);
    // Serialize and derive a stable content hash
    const payload = JSON.stringify(display, null, 2) + '\n';
    const sha = sha256Hex(payload);
    const manifest = {
        version: sha.slice(0, 12),
        generatedAt: new Date().toISOString(),
        sha256: sha
    };
    const wroteData = await writeTextIfChanged('data/latest.json', payload);
    const wroteManifest = await writeTextIfChanged('data/manifest.json', JSON.stringify(manifest, null, 2) + '\n');
    if (wroteData === 'skipped' && wroteManifest === 'skipped') {
        console.log('No changes in dataset.');
    }
    else {
        console.log('Dataset updated:', manifest);
    }
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
