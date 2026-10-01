import { BadRequestException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { HttpService } from '@nestjs/axios';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { createDecipheriv } from 'node:crypto';
import { of, throwError } from 'rxjs';
import { AdminLlmService } from './admin-llm.service.js';
import { SetLlmChainDto } from './dto/llm.dto.js';
import type { PrismaService } from '../prisma/prisma.service.js';

// Same key as ai-backend/tests/test_llm_config.py's Node-produced vector, so
// the two suites pin one shared format: base64(iv(12) | ciphertext | tag(16)).
const KEY_B64 = Buffer.alloc(32, 7).toString('base64');

function makePrisma() {
  return {
    app_setting: { findUnique: vi.fn().mockResolvedValue(null), upsert: vi.fn() },
    llm_provider_key: { findMany: vi.fn().mockResolvedValue([]), upsert: vi.fn(), deleteMany: vi.fn() },
    activity_log: { create: vi.fn() },
  };
}

const AI_STATUS = {
  chain: ['gemini:gemini-3.5-flash-lite'],
  chain_source: 'env',
  keys: { gemini: 'env', groq: 'env', openai: 'none', anthropic: 'db' },
};

function makeHttp({ reachable = true } = {}) {
  return {
    get: vi.fn(() => (reachable ? of({ data: AI_STATUS }) : throwError(() => new Error('ECONNREFUSED')))),
    post: vi.fn(() => (reachable ? of({ data: {} }) : throwError(() => new Error('ECONNREFUSED')))),
  };
}

function makeConfig(values: Record<string, string> = { SETTINGS_ENCRYPTION_KEY: KEY_B64, INTERNAL_API_TOKEN: 'tok' }) {
  return { get: vi.fn((name: string, fallback?: string) => values[name] ?? fallback) };
}

function makeService(prisma = makePrisma(), http = makeHttp(), config = makeConfig()) {
  return new AdminLlmService(
    prisma as unknown as PrismaService,
    http as unknown as HttpService,
    config as unknown as ConfigService,
  );
}

function decrypt(blob: string): string {
  const raw = Buffer.from(blob, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(KEY_B64, 'base64'), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  return Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString('utf8');
}

describe('AdminLlmService.encrypt', () => {
  it('round-trips in the iv | ciphertext | tag format the AI backend reads', () => {
    const blob = makeService().encrypt('sk-test-1234');
    expect(decrypt(blob)).toBe('sk-test-1234');
  });

  it('uses a fresh iv every time', () => {
    const service = makeService();
    expect(service.encrypt('same')).not.toBe(service.encrypt('same'));
  });

  it('refuses to store keys without a valid 32-byte master key', () => {
    const service = makeService(makePrisma(), makeHttp(), makeConfig({ SETTINGS_ENCRYPTION_KEY: 'c2hvcnQ=' }));
    expect(() => service.encrypt('sk-x')).toThrow(BadRequestException);
  });
});

describe('AdminLlmService.setKey', () => {
  it('stores only the encrypted key and last4, and never returns the key', async () => {
    const prisma = makePrisma();
    const service = makeService(prisma);

    const result = await service.setKey('admin-1', 'anthropic', '  sk-ant-secret-9876  ');

    const saved = prisma.llm_provider_key.upsert.mock.calls[0][0].create;
    expect(saved.provider).toBe('anthropic');
    expect(saved.last4).toBe('9876');
    expect(decrypt(saved.encrypted_key)).toBe('sk-ant-secret-9876');
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(prisma.activity_log.create.mock.calls)).not.toContain('secret');
  });

  it('rejects an unknown provider', async () => {
    await expect(makeService().setKey('admin-1', 'mistral', 'sk-123456789')).rejects.toThrow(BadRequestException);
  });

  it('still saves when the AI backend is down (its own refresh applies it later)', async () => {
    const prisma = makePrisma();
    const service = makeService(prisma, makeHttp({ reachable: false }));

    const result = await service.setKey('admin-1', 'openai', 'sk-openai-0000');

    expect(prisma.llm_provider_key.upsert).toHaveBeenCalled();
    expect(result.ai_backend_reachable).toBe(false);
  });
});

describe('AdminLlmService.getConfig', () => {
  it("reports the AI backend's live chain and key sources, with saved last4", async () => {
    const prisma = makePrisma();
    prisma.llm_provider_key.findMany.mockResolvedValue([{ provider: 'anthropic', last4: 'abcd', updated_at: new Date() }]);

    const result = await makeService(prisma).getConfig();

    expect(result.chain).toEqual(AI_STATUS.chain);
    expect(result.providers.find((p) => p.provider === 'anthropic')).toMatchObject({ source: 'db', last4: 'abcd' });
    expect(result.providers.find((p) => p.provider === 'openai')).toMatchObject({ source: 'none', last4: null });
  });

  it('falls back to the saved chain when the AI backend is unreachable', async () => {
    const prisma = makePrisma();
    prisma.app_setting.findUnique.mockResolvedValue({ value: ['groq:openai/gpt-oss-120b'] });

    const result = await makeService(prisma, makeHttp({ reachable: false })).getConfig();

    expect(result).toMatchObject({ chain: ['groq:openai/gpt-oss-120b'], chain_source: 'db', ai_backend_reachable: false });
  });
});

describe('SetLlmChainDto', () => {
  const errorsFor = async (chain: unknown) => validate(plainToInstance(SetLlmChainDto, { chain }));

  it('accepts provider:model entries', async () => {
    expect(await errorsFor(['anthropic:claude-haiku-4-5', 'groq:openai/gpt-oss-120b'])).toHaveLength(0);
  });

  it.each([[[]], [['mistral:large']], [['no-provider']], [['groq:a', 'groq:a']]])('rejects %j', async (chain) => {
    expect((await errorsFor(chain)).length).toBeGreaterThan(0);
  });
});
