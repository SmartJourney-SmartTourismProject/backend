# One-shot migration runner: applies pending SQL migrations to the production
# database (backend/db/migrate.py). Build context: backend/db/
#   docker build -f deploy/migrate.Dockerfile db/
# Run on the server by CD before the new backend starts:
#   docker compose -f compose.prod.yml run --rm migrate
# DATABASE_URL comes from compose; migrate.py strips Prisma's ?schema= query.
FROM python:3.12-slim
RUN pip install --no-cache-dir psycopg2-binary
WORKDIR /app/db
COPY migrate.py ./
COPY migrations ./migrations
ENTRYPOINT ["python", "migrate.py"]
