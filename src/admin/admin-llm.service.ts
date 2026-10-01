import { HttpService } from '@nestjs/axios';
import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, randomBytes } from 'node:crypto';
import { firstValueFrom } from 'rxjs';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { LLM_PROVIDERS, type LlmProvider } from './dto/llm.dto.js';

const CHAIN_KEY = 'llm_provider_chain';

type KeySource = 'db' | 'env' | 'none';

interface AiLlmStatus {
  chain: string[];
  chain_source: 'db' | 'env';
  keys: Record<LlmProvider, KeySource>;
}

export interface LlmTestResult {
  spec: string;
  status: 'ok' | 'quota' | 'auth' | 'not_found' | 'no_key' | 'error';
  message: string;
  latency_ms: number | null;
}

/**
 * Admin > AI models. The chain and any API keys an admin enters are stored
 * here (app_setting / llm_provider_key, 0017_llm_settings.sql) and read by
 * the AI backend (ai-backend/app/core/llm_config.py), which falls back to
 * its .env for anything not saved. Keys are encrypted at rest and never
 * returned - only which source is in effect and the last 4 characters.
 */
@Injectable()
export class AdminLlmService {
  private readonly logger = new Logger(AdminLlmService.name);
  private readonly aiUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {
    this.aiUrl = this.config.get<string>('AI_BACKEND_URL', 'http://localhost:8000');
  }

  async getConfig() {
    const [setting, keyRows, live] = await Promise.all([
      this.prisma.app_setting.findUnique({ where: { key: CHAIN_KEY } }),
      this.prisma.llm_provider_key.findMany({ select: { provider: true, last4: true, updated_at: true } }),
      this.aiStatus(),
    ]);
    const saved = new Map(keyRows.map((k) => [k.provider, k]));
    const savedChain = Array.isArray(setting?.value) ? (setting.value as string[]) : null;

    return {
      // What the AI backend is actually running, when it's reachable.
      chain: live?.chain ?? savedChain ?? [],
      chain_source: live?.chain_source ?? (savedChain ? 'db' : 'env'),
      ai_backend_reachable: live !== null,
      encryption_configured: this.encryptionKey() !== null,
      providers: LLM_PROVIDERS.map((provider) => {
        const row = saved.get(provider);
        return {
          provider,
          source: (live?.keys[provider] ?? (row ? 'db' : 'none')) as KeySource,
          last4: row?.last4 ?? null,
          updated_at: row?.updated_at ?? null,
        };
      }),
    };
  }

  async setChain(adminId: string, chain: string[]) {
    await this.prisma.app_setting.upsert({
      where: { key: CHAIN_KEY },
      create: { key: CHAIN_KEY, value: chain, updated_by: adminId },
      update: { value: chain, updated_by: adminId, updated_at: new Date() },
    });
    await this.log(adminId, 'llm.chain.update', { chain });
    return this.afterChange();
  }

  async setKey(adminId: string, provider: string, key: string) {
    const p = this.provider(provider);
    const trimmed = key.trim();
    const encrypted_key = this.encrypt(trimmed);
    const last4 = trimmed.slice(-4);
    await this.prisma.llm_provider_key.upsert({
      where: { provider: p },
      create: { provider: p, encrypted_key, last4, updated_by: adminId },
      update: { encrypted_key, last4, updated_by: adminId, updated_at: new Date() },
    });
    // Never the key itself - last4 only, same as the UI shows.
    await this.log(adminId, 'llm.key.update', { provider: p, last4 });
    return this.afterChange();
  }

  async clearKey(adminId: string, provider: string) {
    const p = this.provider(provider);
    await this.prisma.llm_provider_key.deleteMany({ where: { provider: p } });
    await this.log(adminId, 'llm.key.clear', { provider: p });
    return this.afterChange();
  }

  async test(): Promise<{ results: LlmTestResult[] }> {
    try {
      const { data } = await firstValueFrom(
        this.http.post<{ results: LlmTestResult[] }>(
          `${this.aiUrl}/internal/llm/test`,
          {},
          { headers: this.internalHeaders(), timeout: 60_000 },
        ),
      );
      return data;
    } catch (error) {
      throw new ServiceUnavailableException(`Could not reach the AI backend to test models: ${String(error)}`);
    }
  }

  /** Encrypts as base64(iv(12) | ciphertext | tag(16)) - the format
   * ai-backend/app/core/llm_config.py's decrypt() reads. */
  encrypt(plaintext: string): string {
    const key = this.encryptionKey();
    if (!key) {
      throw new BadRequestException(
        'SETTINGS_ENCRYPTION_KEY is not set (32 random bytes, base64) in backend/.env and ai-backend/.env, so API keys cannot be saved securely.',
      );
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString('base64');
  }

  private encryptionKey(): Buffer | null {
    const raw = this.config.get<string>('SETTINGS_ENCRYPTION_KEY');
    if (!raw) return null;
    const key = Buffer.from(raw, 'base64');
    return key.length === 32 ? key : null;
  }

  private provider(provider: string): LlmProvider {
    if (!(LLM_PROVIDERS as readonly string[]).includes(provider)) {
      throw new BadRequestException(`Unknown provider "${provider}"`);
    }
    return provider as LlmProvider;
  }

  private internalHeaders() {
    return { 'X-Internal-Token': this.config.get<string>('INTERNAL_API_TOKEN', '') };
  }

  /** Asks the AI backend to pick the change up now. If it can't be reached,
   * its own 30s refresh still applies the change - so this never fails the save. */
  private async afterChange() {
    try {
      await firstValueFrom(
        this.http.post(`${this.aiUrl}/internal/llm/reload`, {}, { headers: this.internalHeaders(), timeout: 10_000 }),
      );
    } catch (error) {
      this.logger.warn(`AI backend reload after an LLM settings change failed: ${String(error)}`);
    }
    return this.getConfig();
  }

  private async aiStatus(): Promise<AiLlmStatus | null> {
    try {
      const { data } = await firstValueFrom(
        this.http.get<AiLlmStatus>(`${this.aiUrl}/internal/llm/status`, {
          headers: this.internalHeaders(),
          timeout: 5_000,
        }),
      );
      return data;
    } catch {
      return null;
    }
  }

  private async log(adminId: string, action: string, detail: Prisma.InputJsonValue) {
    try {
      await this.prisma.activity_log.create({ data: { user_id: adminId, action, detail } });
    } catch (error) {
      this.logger.error(`Failed to write activity_log for ${action}: ${String(error)}`);
    }
  }
}
