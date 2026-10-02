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

# PGDG retired its Debian 11 (bullseye) suite some time after 2026-09-30, so
# the repo the base image ships now answers 404 and `apt-get update` fails the
# whole build:
#
#   Err: http://apt.postgresql.org/pub/repos/apt bullseye-pgdg Release
#     404  Not Found
#   E: The repository '... bullseye-pgdg Release' does not have a Release file.
#
# The package itself is still published, in PGDG's archive - the same
# 0.8.6-1.pgdg11+1 this file was originally written against. Pointing at the
# archive keeps the base image, and therefore PostGIS and the Postgres 16 major
# version, exactly as they were, so an existing db_data volume is untouched.
# (postgis/postgis publishes no bookworm-based 16 tag to move to, and
# pgvector's own image carries no PostGIS.)
#
# Check-Valid-Until is off because an archived suite's Release file is, by
# definition, past its expiry. The repo is still signature-verified, using the
# keyring the base image already ships.
RUN rm -f /etc/apt/sources.list.d/pgdg.list \
    && echo "deb [signed-by=/usr/local/share/keyrings/postgres.gpg.asc] http://apt-archive.postgresql.org/pub/repos/apt bullseye-pgdg-archive main" \
       > /etc/apt/sources.list.d/pgdg-archive.list \
    && apt-get update -o Acquire::Check-Valid-Until=false \
    && apt-get install -y --no-install-recommends postgresql-16-pgvector \
    && rm -rf /var/lib/apt/lists/*

# Extensions (postgis, pg_trgm, uuid-ossp, vector) are created on first init of
# an EMPTY data volume. Locally docker-compose.yml bind-mounts ./db/init over
# this folder; in production there is no mount, so the script is baked in.
COPY init/ /docker-entrypoint-initdb.d/
