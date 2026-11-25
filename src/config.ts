import { z } from 'zod';

/**
 * Environment variables are strings, so `z.coerce.boolean()` is the wrong tool:
 * it turns the string "false" into `true`. Parse the accepted spellings explicitly.
 */
const booleanFromEnv = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    DATABASE_URL: z.string().min(1),
    DATABASE_SSL: booleanFromEnv.default(false),

    EMBEDDINGS_PROVIDER: z.enum(['openai', 'hash']).default('openai'),
    EMBEDDINGS_API_KEY: z.string().min(1).optional(),
    EMBEDDINGS_BASE_URL: z.url().default('https://api.openai.com/v1'),
    EMBEDDINGS_MODEL: z.string().min(1).default('text-embedding-3-small'),

    RAG_TOP_K: z.coerce.number().int().min(1).max(50).default(5),
    RAG_MIN_SCORE: z.coerce.number().min(0).max(1).default(0.3),
    CHUNK_MAX_CHARS: z.coerce.number().int().min(100).max(8000).default(1000),
    CHUNK_OVERLAP_CHARS: z.coerce.number().int().min(0).default(150),
  })
  .superRefine((env, ctx) => {
    if (env.EMBEDDINGS_PROVIDER === 'openai' && env.EMBEDDINGS_API_KEY === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['EMBEDDINGS_API_KEY'],
        message: 'required when EMBEDDINGS_PROVIDER is "openai"',
      });
    }
    if (env.EMBEDDINGS_PROVIDER === 'hash' && env.NODE_ENV === 'production') {
      ctx.addIssue({
        code: 'custom',
        path: ['EMBEDDINGS_PROVIDER'],
        message: '"hash" is a development embedder and cannot be used in production',
      });
    }
    if (env.CHUNK_OVERLAP_CHARS >= env.CHUNK_MAX_CHARS) {
      ctx.addIssue({
        code: 'custom',
        path: ['CHUNK_OVERLAP_CHARS'],
        message: 'must be smaller than CHUNK_MAX_CHARS',
      });
    }
  });

type Env = z.infer<typeof schema>;

export interface Config {
  readonly nodeEnv: Env['NODE_ENV'];
  readonly port: number;
  readonly logLevel: Env['LOG_LEVEL'];
  readonly database: { readonly url: string; readonly ssl: boolean };
  readonly embeddings: {
    readonly provider: Env['EMBEDDINGS_PROVIDER'];
    readonly apiKey: string | undefined;
    readonly baseUrl: string;
    readonly model: string;
  };
  readonly rag: {
    readonly topK: number;
    readonly minScore: number;
    readonly chunkMaxChars: number;
    readonly chunkOverlapChars: number;
  };
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/**
 * Reads and validates configuration. Takes the environment as an argument
 * rather than reading a module-level singleton, so it can be tested and so
 * nothing is parsed at import time.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  // An empty value in a .env file ("KEY=") means "not set".
  const present = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined && value !== ''),
  );

  const parsed = schema.safeParse(present);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new ConfigError(`Invalid configuration:\n${problems}`);
  }

  const e = parsed.data;
  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    database: { url: e.DATABASE_URL, ssl: e.DATABASE_SSL },
    embeddings: {
      provider: e.EMBEDDINGS_PROVIDER,
      apiKey: e.EMBEDDINGS_API_KEY,
      baseUrl: e.EMBEDDINGS_BASE_URL.replace(/\/+$/, ''),
      model: e.EMBEDDINGS_MODEL,
    },
    rag: {
      topK: e.RAG_TOP_K,
      minScore: e.RAG_MIN_SCORE,
      chunkMaxChars: e.CHUNK_MAX_CHARS,
      chunkOverlapChars: e.CHUNK_OVERLAP_CHARS,
    },
  };
}
