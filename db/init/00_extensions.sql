-- Runs automatically via docker-compose's docker-entrypoint-initdb.d mount,
-- on first container init only (an existing data volume skips this - see
-- docs/master_plan/DATA_PLATFORM.md §1 for the "empty data dir" gotcha).
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pg_trgm;      -- fuzzy place-name matching (geo_tool.py)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS vector;       -- RAG knowledge_chunk.embedding (db/Dockerfile, migration 0013)
