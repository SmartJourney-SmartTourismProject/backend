# Adds pgvector to the project's Postgres image, for the RAG knowledge base
# (knowledge_chunk.embedding - db/migrations/0013_knowledge_base.sql).
#
# postgis/postgis:16-3.4 already has the PGDG apt repo configured (it's how
# the base image installs postgresql-16 itself), so postgresql-16-pgvector
# installs as a plain apt package - no compiler, no pgvector source checkout.
# Confirmed available 2026-09-30: apt-cache policy showed 0.8.6-1.pgdg11+1
# candidate directly, against the already-running smartjourney_postgres
# container.
#
# Same Postgres 16 major version as the base image, so an EXISTING db_data
# volume is untouched by this switch - only `CREATE EXTENSION vector;`
# (migration 0013) is new, not a data migration.
FROM postgis/postgis:16-3.4

RUN apt-get update \
    && apt-get install -y --no-install-recommends postgresql-16-pgvector \
    && rm -rf /var/lib/apt/lists/*

# Extensions (postgis, pg_trgm, uuid-ossp, vector) are created on first init of
# an EMPTY data volume. Locally docker-compose.yml bind-mounts ./db/init over
# this folder; in production there is no mount, so the script is baked in.
COPY init/ /docker-entrypoint-initdb.d/
