import { INestApplication, ValidationPipe } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Test, TestingModule } from '@nestjs/testing';
import jwt from 'jsonwebtoken';
import { ExtractJwt, Strategy } from 'passport-jwt';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module.js';
import { JwtStrategy } from '../src/auth/jwt.strategy.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

// JwtStrategy's own constructor (overridden below, but still declared as a
// provider in AuthModule) reads this at module-scan time.
process.env.KEYCLOAK_ISSUER ??= 'http://kc-test/realms/smartjourney';

const JWT_SECRET = 'e2e-test-secret';

/**
 * Stands in for the real Keycloak-backed JwtStrategy so these tests need
 * neither a running Keycloak nor Postgres: same passport strategy name
 * ('keycloak-jwt', matched by JwtAuthGuard's `AuthGuard('keycloak-jwt')'),
 * same shape of `validate()` return value (see users.service.ts's
 * AuthenticatedUser), but a symmetric test secret instead of the realm's
 * JWKS. Only the trust anchor changes - the guard chain (JwtAuthGuard,
 * RolesGuard, @CurrentUser) runs for real, unmocked.
 */
class FakeKeycloakStrategy extends PassportStrategy(Strategy, 'keycloak-jwt') {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: JWT_SECRET,
    });
  }

  validate(payload: { id: string; roles: string[] }) {
    return payload;
  }
}

function bearerFor(user: { id: string; roles: string[] }): string {
  return `Bearer ${jwt.sign(user, JWT_SECRET)}`;
}

/** Enough of the Prisma surface for the routes exercised below. */
function makeFakePrisma(itineraries: unknown[] = []) {
  return {
    itinerary: {
      findMany: vi.fn().mockResolvedValue(itineraries),
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    // The trip list's cover-photo lookup (trips.service coverPhotos).
    itinerary_item: { findMany: vi.fn().mockResolvedValue([]) },
    expense: { groupBy: vi.fn().mockResolvedValue([]) },
    // GET /health's database probe.
    $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
  };
}

async function buildApp(itineraries: unknown[] = []): Promise<INestApplication<App>> {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(PrismaService)
    .useValue(makeFakePrisma(itineraries))
    .overrideProvider(JwtStrategy)
    .useClass(FakeKeycloakStrategy)
    .compile();

  const app = moduleFixture.createNestApplication();
  // Mirrors src/main.ts's bootstrap - not applied automatically to a
  // TestingModule, so it has to be repeated here to actually exercise it.
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  await app.init();
  return app;
}

describe('App (e2e)', () => {
  it('GET / is public and needs no identity', async () => {
    const app = await buildApp();
    await request(app.getHttpServer()).get('/').expect(200).expect('Hello World!');
    await app.close();
  });

  it('GET /health is public and reports ok when the database answers', async () => {
    const app = await buildApp();
    await request(app.getHttpServer()).get('/health').expect(200).expect({ status: 'ok' });
    await app.close();
  });

  it('a protected route with no bearer token is rejected with 401', async () => {
    const app = await buildApp();
    await request(app.getHttpServer()).get('/trips').expect(401);
    await app.close();
  });

  it('a traveler hitting /admin/stats gets 403, not a peek at the data', async () => {
    const app = await buildApp();
    await request(app.getHttpServer())
      .get('/admin/stats')
      .set('Authorization', bearerFor({ id: 'user-1', roles: ['traveler'] }))
      .expect(403);
    await app.close();
  });

  it('POST /trips rejects an unknown field instead of silently dropping it', async () => {
    const app = await buildApp();
    await request(app.getHttpServer())
      .post('/trips')
      .set('Authorization', bearerFor({ id: 'user-1', roles: ['traveler'] }))
      .send({ destination: 'Kandy', itinerary: [{ day: 1, items: [] }], not_a_real_field: 'x' })
      .expect(400);
    await app.close();
  });

  it("GET /trips returns the caller's own trips", async () => {
    const app = await buildApp([{ id: 'trip-owned-by-caller', user_id: 'user-1' }]);
    const res = await request(app.getHttpServer())
      .get('/trips')
      .set('Authorization', bearerFor({ id: 'user-1', roles: ['traveler'] }))
      .expect(200);
    expect(res.body).toEqual([{ id: 'trip-owned-by-caller', user_id: 'user-1', cover_photo_url: null }]);
    await app.close();
  });

  it('GET /budget/summary returns [] for a traveler with no trips yet', async () => {
    const app = await buildApp();
    const res = await request(app.getHttpServer())
      .get('/budget/summary')
      .set('Authorization', bearerFor({ id: 'user-1', roles: ['traveler'] }))
      .expect(200);
    expect(res.body).toEqual([]);
    await app.close();
  });
});
