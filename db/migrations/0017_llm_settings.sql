-- Admin-managed LLM configuration (Admin > AI models).
--
-- app_setting: small key/value settings an admin can change at runtime.
--   'llm_provider_chain' -> JSON array of "<provider>:<model>", tried in
--   order (first = main model, the rest = failover). No row = the AI
--   backend's LLM_PROVIDER_CHAIN env var, exactly as before.
--
-- llm_provider_key: provider API keys entered in the admin panel, encrypted
--   with AES-256-GCM under SETTINGS_ENCRYPTION_KEY (shared by NestJS, which
--   writes them, and the AI backend, which reads them). Stored as base64 of
--   iv(12) | ciphertext | tag(16). No row = that provider's key from .env.
--   Only last4 is ever shown back to an admin.
CREATE TABLE IF NOT EXISTS app_setting (
    key         text PRIMARY KEY,
    value       jsonb NOT NULL,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    updated_by  uuid REFERENCES app_user(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS llm_provider_key (
    provider       text PRIMARY KEY CHECK (provider IN ('gemini', 'groq', 'openai', 'anthropic')),
    encrypted_key  text NOT NULL,
    last4          text NOT NULL,
    updated_at     timestamptz NOT NULL DEFAULT now(),
    updated_by     uuid REFERENCES app_user(id) ON DELETE SET NULL
);
