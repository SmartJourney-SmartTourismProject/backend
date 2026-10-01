# Production Keycloak with the SmartJourney realm + login theme baked in.
# Build context: backend/keycloak/   (docker build -f deploy/keycloak.Dockerfile keycloak/)
#
# `kc.sh build` bakes the build-time options (database vendor, health endpoints)
# so the container starts with `start --optimized` - much faster than start-dev
# and not suitable-for-production warnings are gone. Runtime settings (hostname,
# DB credentials, admin bootstrap) come from compose.prod.yml.
FROM quay.io/keycloak/keycloak:26.0 AS build
ENV KC_DB=postgres \
    KC_HEALTH_ENABLED=true
COPY themes/smartjourney /opt/keycloak/themes/smartjourney
RUN /opt/keycloak/bin/kc.sh build

FROM quay.io/keycloak/keycloak:26.0
COPY --from=build /opt/keycloak/ /opt/keycloak/
# Imported on first start only (--import-realm); ${NAME} placeholders in the
# file (FRONTEND_URL, client secrets, SMTP, Google) are filled from the
# container's environment.
COPY realm-export.json /opt/keycloak/data/import/smartjourney-realm.json
ENTRYPOINT ["/opt/keycloak/bin/kc.sh"]
