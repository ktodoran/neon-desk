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
    // Keep this low on serverless runtimes, where every instance holds its own pool.
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

    EMBEDDINGS_PROVIDER: z.enum(['openai', 'hash']).default('openai'),
    EMBEDDINGS_API_KEY: z.string().min(1).optional(),
    EMBEDDINGS_BASE_URL: z.url().default('https://api.openai.com/v1'),
    EMBEDDINGS_MODEL: z.string().min(1).default('text-embedding-3-small'),

    // Chat is optional: without an LLM the server still ingests, searches and reports health.
    LLM_PROVIDER: z.enum(['anthropic', 'openai']).optional(),
    LLM_API_KEY: z.string().min(1).optional(),
    LLM_MODEL: z.string().min(1).optional(),
    LLM_BASE_URL: z.url().optional(),
    LLM_MAX_TOKENS: z.coerce.number().int().min(64).max(8192).default(800),

    COMPANY_NAME: z.string().min(1).default('our company'),
    SUPPORT_CONTACT: z.string().min(1).default('our support team'),

    RAG_TOP_K: z.coerce.number().int().min(1).max(50).default(5),
    RAG_CANDIDATES: z.coerce.number().int().min(1).max(200).default(20),
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
    if (env.LLM_PROVIDER !== undefined) {
      // No default model on purpose. A hardcoded model name goes stale and then
      // fails in production; the operator states which model they are paying for.
      for (const key of ['LLM_API_KEY', 'LLM_MODEL'] as const) {
        if (env[key] === undefined) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: 'required when LLM_PROVIDER is set',
          });
        }
      }
    }
    if (env.RAG_CANDIDATES < env.RAG_TOP_K) {
      ctx.addIssue({
        code: 'custom',
        path: ['RAG_CANDIDATES'],
        message: 'must be at least RAG_TOP_K',
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

const DEFAULT_LLM_BASE_URL = {
  anthropic: 'https://api.anthropic.com/v1',
  openai: 'https://api.openai.com/v1',
} as const;

export interface Config {
  readonly nodeEnv: Env['NODE_ENV'];
  readonly port: number;
  readonly logLevel: Env['LOG_LEVEL'];
  readonly database: { readonly url: string; readonly ssl: boolean; readonly poolMax: number };
  readonly embeddings: {
    readonly provider: Env['EMBEDDINGS_PROVIDER'];
    readonly apiKey: string | undefined;
    readonly baseUrl: string;
    readonly model: string;
  };
  /** Undefined when no LLM is configured; the chat endpoint is then unavailable. */
  readonly llm:
    | {
        readonly provider: 'anthropic' | 'openai';
        readonly apiKey: string;
        readonly model: string;
        readonly baseUrl: string;
        readonly maxTokens: number;
      }
    | undefined;
  readonly assistant: { readonly companyName: string; readonly supportContact: string };
  readonly rag: {
    readonly topK: number;
    readonly candidates: number;
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
  const llm =
    e.LLM_PROVIDER !== undefined && e.LLM_API_KEY !== undefined && e.LLM_MODEL !== undefined
      ? {
          provider: e.LLM_PROVIDER,
          apiKey: e.LLM_API_KEY,
          model: e.LLM_MODEL,
          baseUrl: (e.LLM_BASE_URL ?? DEFAULT_LLM_BASE_URL[e.LLM_PROVIDER]).replace(/\/+$/, ''),
          maxTokens: e.LLM_MAX_TOKENS,
        }
      : undefined;

  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    database: { url: e.DATABASE_URL, ssl: e.DATABASE_SSL, poolMax: e.DATABASE_POOL_MAX },
    embeddings: {
      provider: e.EMBEDDINGS_PROVIDER,
      apiKey: e.EMBEDDINGS_API_KEY,
      baseUrl: e.EMBEDDINGS_BASE_URL.replace(/\/+$/, ''),
      model: e.EMBEDDINGS_MODEL,
    },
    llm,
    assistant: { companyName: e.COMPANY_NAME, supportContact: e.SUPPORT_CONTACT },
    rag: {
      topK: e.RAG_TOP_K,
      candidates: e.RAG_CANDIDATES,
      minScore: e.RAG_MIN_SCORE,
      chunkMaxChars: e.CHUNK_MAX_CHARS,
      chunkOverlapChars: e.CHUNK_OVERLAP_CHARS,
    },
  };
}
