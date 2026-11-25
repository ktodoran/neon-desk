import { readdir, readFile } from 'node:fs/promises';
import { basename, extname, join, relative } from 'node:path';
import { loadConfig } from '../config.js';
import { createPostgresDatabase } from '../db/postgres.js';
import { createEmbedder } from '../rag/embeddings.js';
import { ingestDocument } from '../rag/ingest.js';

/** Ingests every Markdown file under a directory. Usage: npm run ingest -- <dir> */

async function markdownFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.md')
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

function titleOf(content: string, path: string): string {
  const heading = /^#\s+(.+)$/m.exec(content);
  return heading?.[1]?.trim() ?? basename(path, extname(path));
}

const dir = process.argv[2];
if (dir === undefined) {
  console.error('Usage: npm run ingest -- <directory of .md files>');
  process.exit(1);
}

const config = loadConfig();
const db = createPostgresDatabase({
  connectionString: config.database.url,
  ssl: config.database.ssl,
});
const embedder = createEmbedder(config.embeddings);
const chunking = {
  maxChars: config.rag.chunkMaxChars,
  overlapChars: config.rag.chunkOverlapChars,
};

try {
  for (const path of await markdownFiles(dir)) {
    const content = await readFile(path, 'utf8');
    const result = await ingestDocument(
      { db, embedder, chunking },
      { source: 'files', externalId: relative(dir, path), title: titleOf(content, path), content },
    );
    console.log(
      `${result.status.padEnd(9)} ${relative(dir, path)} (${String(result.chunks)} chunks)`,
    );
  }
} finally {
  await db.close();
}
