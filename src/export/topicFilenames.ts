import { sanitizeFilename } from '../domain/sanitize';

export function getTopicFilenames(topics: string[]): Map<string, string> {
  const occupied = new Set<string>();
  const names = new Map<string, string>();
  for (const topic of [...new Set(topics)].sort()) {
    const base = Array.from(sanitizeFilename(topic)).slice(0, 60).join('').replace(/[. ]+$/, '');
    let filename = `${base}.md`;
    let suffix = 2;
    while (occupied.has(filename.normalize('NFC').toLowerCase())) {
      filename = `${base}-${suffix++}.md`;
    }
    occupied.add(filename.normalize('NFC').toLowerCase());
    names.set(topic, filename);
  }
  return names;
}
