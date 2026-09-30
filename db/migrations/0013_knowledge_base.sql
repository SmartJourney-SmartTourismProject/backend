-- The RAG knowledge base: unstructured travel knowledge no other table
-- holds (visas, safety, etiquette, transport, costs) - see
-- ai-backend/docs/master_plan/PROJECT_MASTER_PLAN.md decision D11 (RAG was
-- demoted, then deleted, for re-ranking a candidate list the deterministic
-- scorer already ranks better; this is the opposite job - answering a
-- question, not choosing a place). db/Dockerfile adds the `vector`
-- extension this migration needs.

CREATE EXTENSION IF NOT EXISTS vector;

-- One row per SOURCE page/file (a Wikivoyage article, a team-written note),
-- chunked below. Kept separate from knowledge_chunk so re-ingesting a page
-- can diff by content_hash without touching chunks that haven't changed,
-- and so license/attribution lives once per document, not once per chunk.
CREATE TABLE knowledge_document (
    id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    source        text NOT NULL,                    -- wikivoyage | team_note
    source_ref    text NOT NULL,                     -- Wikivoyage page title, or the note's filename
    title         text NOT NULL,
    url           text,                               -- NULL only for a team_note with no public source
    license       text NOT NULL,                      -- "CC BY-SA 3.0" (wikivoyage) | "internal" (team_note)
    -- NULL = country-level (applies everywhere, e.g. "Visa rules"), not
    -- "unresolved" - resolve_place() runs at ingest time, not query time.
    district_id   uuid REFERENCES district(id),
    content_hash  text NOT NULL,                      -- sha256 of the fetched text; unchanged -> skip re-chunk/re-embed
    -- Team notes are hand-checked against an official source and dated;
    -- Wikivoyage pages have no such date (community-edited, no citation),
    -- so this stays NULL for those - the answer prompt cites the page
    -- itself, not a verification date nobody actually gave it.
    last_verified date,
    fetched_at    timestamptz NOT NULL DEFAULT now(),
    is_active     boolean NOT NULL DEFAULT true,
    UNIQUE (source, source_ref)
);
CREATE INDEX knowledge_document_district ON knowledge_document (district_id) WHERE is_active;

CREATE TABLE knowledge_chunk (
    id             uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    document_id    uuid NOT NULL REFERENCES knowledge_document(id) ON DELETE CASCADE,
    chunk_index    integer NOT NULL,                  -- position within the document, for citation context
    section        text,                               -- "Stay safe" / "Visa rules" - shown in citations
    content        text NOT NULL,
    -- Denormalized from knowledge_document for the retrieval query's WHERE
    -- clause - joining per-search over what can be thousands of chunks
    -- would cost more than copying one column at ingest time.
    district_id    uuid REFERENCES district(id),
    -- text search catches proper nouns and acronyms ("Dalada Maligawa",
    -- "ETA") that an embedding can blur - retrieve.py takes the union of
    -- both (RRF), not vector search alone.
    tsv            tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
    -- NULL until app/rag/embeddings.py embeds it (ingest and embedding are
    -- separate steps - a connector can write chunks even when the
    -- embedding API is down, and a pending chunk still serves full-text
    -- search meanwhile).
    embedding      vector(768),
    -- Which model produced `embedding` - a future OpenAI switch (see
    -- ai-backend's EMBEDDING_PROVIDER_CHAIN) needs a full re-embed, since
    -- vectors from different models/dimensions cannot be compared; this
    -- column is what makes that a WHERE clause instead of a guess.
    embedding_model text
);
CREATE INDEX knowledge_chunk_fts ON knowledge_chunk USING gin (tsv);
CREATE INDEX knowledge_chunk_district ON knowledge_chunk (district_id);
CREATE INDEX knowledge_chunk_document ON knowledge_chunk (document_id);
-- HNSW, not IVFFlat: no training step needed (IVFFlat wants representative
-- data present before the index is useful), and a corpus this size
-- (low thousands of chunks) doesn't need IVFFlat's memory savings.
CREATE INDEX knowledge_chunk_embedding ON knowledge_chunk
    USING hnsw (embedding vector_cosine_ops);
