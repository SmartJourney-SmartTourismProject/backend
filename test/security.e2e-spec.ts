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

/**
 * SECURITY TESTING — system-level security.
 *
 * "Can an unauthenticated or forged identity get in at all?"  Every case here
 * attacks the front door; none of them assume a valid user. The companion
 * suite, access-control.e2e-spec.ts, starts *after* the door has been opened
 * and asks what a valid identity is allowed to reach.
 *
 * This matters more here than in a typical three-tier app: `ai-backend` has no
 * authentication of its own, so the NestJS guard chain proved below is the only
 * trust boundary in the whole system (Master Test Plan §3.1.6).
 *
 * The guard chain runs for real - JwtAuthGuard, the passport strategy, and the
 * global ValidationPipe are all the production ones. Only the trust anchor is
 * swapped: a symmetric test secret instead of Keycloak's JWKS, so the suite
 * needs neither Keycloak nor Postgres running.
 */

process.env.KEYCLOAK_ISSUER ??= 'http://kc-test/realms/smartjourney';

const JWT_SECRET = 'e2e-test-secret';
/** A different key, standing in for an attacker who does not hold the realm's. */
const ATTACKER_SECRET = 'not-the-realms-signing-key';

class FakeKeycloakStrategy extends PassportStrategy(Strategy, 'keycloak-jwt') {
  constructor() {
    super({ jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(), secretOrKey: JWT_SECRET });
  }

  validate(payload: { id: string; roles: string[] }) {
    return payload;
  }
}

function makeFakePrisma() {
  return {
    itinerary: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn(), create: vi.fn() },
    expense: { groupBy: vi.fn().mockResolvedValue([]) },
  };
}

async function buildApp(): Promise<INestApplication<App>> {
  const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService)
    .useValue(makeFakePrisma())
    .overrideProvider(JwtStrategy)
    .useClass(FakeKeycloakStrategy)
    .compile();

  const app = moduleFixture.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  await app.init();
  return app;
}

describe('Security testing — authentication (system-level)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('SEC-01: a protected route with no credentials is rejected with 401', async () => {
    await request(app.getHttpServer()).get('/trips').expect(401);
  });

  it('SEC-02: a forged token signed with the wrong key is rejected with 401', async () => {
    // The whole security model rests on this: possession of a well-formed token
    // proves nothing unless it was signed by the realm's key.
    const forged = jwt.sign({ id: 'attacker', roles: ['admin'] }, ATTACKER_SECRET);
    await request(app.getHttpServer())
      .get('/trips')
      .set('Authorization', `Bearer ${forged}`)
      .expect(401);
  });

  it('SEC-03: a forged ADMIN token cannot reach an admin route', async () => {
    // Same forgery, aimed at the highest-value target: privilege is claimed in
    // the token body, so an unverified signature would hand over the admin API.
    const forgedAdmin = jwt.sign({ id: 'attacker', roles: ['admin'] }, ATTACKER_SECRET);
    await request(app.getHttpServer())
      .get('/admin/stats')
      .set('Authorization', `Bearer ${forgedAdmin}`)
      .expect(401);
  });

  it('SEC-04: an expired token is rejected with 401', async () => {
    const expired = jwt.sign({ id: 'user-1', roles: ['traveler'] }, JWT_SECRET, { expiresIn: '-1h' });
    await request(app.getHttpServer())
      .get('/trips')
      .set('Authorization', `Bearer ${expired}`)
      .expect(401);
  });

  it('SEC-05: a malformed token is rejected with 401, not a 500', async () => {
    // A parser crash here would be an availability bug as well as a security one.
    await request(app.getHttpServer())
      .get('/trips')
      .set('Authorization', 'Bearer not.a.real.token')
      .expect(401);
  });

  it('SEC-06: a token sent without the Bearer scheme is rejected with 401', async () => {
    const valid = jwt.sign({ id: 'user-1', roles: ['traveler'] }, JWT_SECRET);
    await request(app.getHttpServer()).get('/trips').set('Authorization', valid).expect(401);
  });

  it('SEC-07: a validly signed token is accepted (the negatives above are not false positives)', async () => {
    // Control case: without it, a guard that rejected *everything* would make
    // SEC-01..06 pass while the application was entirely broken.
    const valid = jwt.sign({ id: 'user-1', roles: ['traveler'] }, JWT_SECRET);
    await request(app.getHttpServer())
      .get('/trips')
      .set('Authorization', `Bearer ${valid}`)
      .expect(200);
  });

  it('SEC-08: a public route stays reachable without any identity', async () => {
    await request(app.getHttpServer()).get('/').expect(200);
  });
});
