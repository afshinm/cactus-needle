import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const directory = new URL('../vendor/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', directory), 'utf8'));
// Verify all downloads before replacing any tracked file.
const downloads = [];
for (const [name, artifact] of Object.entries(manifest.files)) {
  const url = `https://huggingface.co/${manifest.repository}/resolve/${manifest.revision}/${artifact.path}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (
    bytes.length !== artifact.size ||
    createHash('sha256').update(bytes).digest('hex') !== artifact.sha256
  ) {
    throw new Error(`${name}: download does not match the pinned checksum.`);
  }
  downloads.push([name, bytes]);
}
for (const [name, bytes] of downloads) await writeFile(new URL(name, directory), bytes);
console.log(`Downloaded and verified ${downloads.length} upstream artifacts.`);
