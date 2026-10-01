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
 * ACCESS CONTROL TESTING — application-level security.
 *
 * Every caller here is already authenticated. The question is no longer "who
 * are you?" but "what are you allowed to reach?", along two axes:
 *
 *   ROLE     - a traveler must not reach an admin route (RolesGuard).
 *   OWNERSHIP - a traveler must not reach another traveler's data, even on a
 *               route they are entitled to use.
 *
 * Ownership violations answer 404, never 403: 403 would confirm the row exists
 * and leak the fact that someone else owns it. The tests assert that
 * deliberately, so the behaviour cannot be "fixed" into a leak later.
 */

process.env.KEYCLOAK_ISSUER ??= 'http://kc-test/realms/smartjourney';

const JWT_SECRET = 'e2e-test-secret';

const TRAVELER_A = { id: 'traveler-a', roles: ['traveler'] };
const TRAVELER_B = { id: 'traveler-b', roles: ['traveler'] };
const ADMIN = { id: 'admin-1', roles: ['traveler', 'admin'] };

/**
 * A trip that belongs to traveler A and to nobody else. The id must be a real
 * UUID: the trip routes parse it with ParseUUIDPipe, which rejects anything
 * else with a 400 before the ownership check is ever reached.
 */
const TRIP_OF_A = { id: '3f1a6c2e-8b4d-4f7a-9c21-5ad0e7b91c44', user_id: TRAVELER_A.id, title: 'Kandy' };

class FakeKeycloakStrategy extends PassportStrategy(Strategy, 'keycloak-jwt') {
  constructor() {
    super({ jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(), secretOrKey: JWT_SECRET });
  }

  validate(payload: { id: string; roles: string[] }) {
    return payload;
  }
}

function bearerFor(user: { id: string; roles: string[] }): string {
  return `Bearer ${jwt.sign(user, JWT_SECRET)}`;
}

/**
 * Stands in for the database, and enforces ownership the way Postgres would:
 * `findFirst`/`findMany` honour the `user_id` in the query's `where`, so a
 * service that forgot to scope its query would visibly return another user's
 * row and fail the test.
 */
function makeFakePrisma() {
  const trips = [TRIP_OF_A];
  const matches = (where: { id?: string; user_id?: string } = {}) =>
    trips.filter(
      (t) => (where.id === undefined || t.id === where.id) && (where.user_id === undefined || t.user_id === where.user_id),
    );

  return {
    itinerary: {
      findMany: vi.fn(({ where }: { where?: { user_id?: string } } = {}) => Promise.resolve(matches(where))),
      findFirst: vi.fn(({ where }: { where?: { id?: string; user_id?: string } } = {}) =>
        Promise.resolve(matches(where)[0] ?? null),
      ),
      create: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
      update: vi.fn(),
      delete: vi.fn(),
    },
    // The trip list looks up a cover photo from its stops (trips.service
    // coverPhotos): no stops here, so every trip gets cover_photo_url: null.
    itinerary_item: { findMany: vi.fn().mockResolvedValue([]) },
    expense: { groupBy: vi.fn().mockResolvedValue([]) },
    app_user: { count: vi.fn().mockResolvedValue(0) },
    chat_session: { count: vi.fn().mockResolvedValue(0) },
    travel_listing: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
    local_event: { count: vi.fn().mockResolvedValue(0) },
    // /admin/stats also counts entry fees awaiting review.
    listing_entry_fee: { count: vi.fn().mockResolvedValue(0) },
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

describe('Access control testing — authorization (application-level)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
  });

  // ---- Role-based access ----------------------------------------------

  it('AC-01: a traveler is refused an admin route with 403', async () => {
    await request(app.getHttpServer())
      .get('/admin/stats')
      .set('Authorization', bearerFor(TRAVELER_A))
      .expect(403);
  });

  it('AC-02: a traveler is refused admin user management with 403', async () => {
    await request(app.getHttpServer())
      .get('/admin/users')
      .set('Authorization', bearerFor(TRAVELER_A))
      .expect(403);
  });

  it('AC-03: an admin is granted the same admin route', async () => {
    // The mirror of AC-01: proves the 403 above is the role check working,
    // not the route being broken for everyone.
    await request(app.getHttpServer())
      .get('/admin/stats')
      .set('Authorization', bearerFor(ADMIN))
      .expect(200);
  });

  // ---- Ownership -------------------------------------------------------

  it('AC-04: a traveler sees only their own trips in a list', async () => {
    const asA = await request(app.getHttpServer())
      .get('/trips')
      .set('Authorization', bearerFor(TRAVELER_A))
      .expect(200);
    expect(asA.body).toEqual([{ ...TRIP_OF_A, cover_photo_url: null }]);

    const asB = await request(app.getHttpServer())
      .get('/trips')
      .set('Authorization', bearerFor(TRAVELER_B))
      .expect(200);
    expect(asB.body).toEqual([]);
  });

  it("AC-05: a traveler reading another traveler's trip gets 404, not the row", async () => {
    const res = await request(app.getHttpServer())
      .get(`/trips/${TRIP_OF_A.id}`)
      .set('Authorization', bearerFor(TRAVELER_B))
      .expect(404);
    expect(JSON.stringify(res.body)).not.toContain(TRIP_OF_A.title);
  });

  it('AC-06: the owner can read the very same trip (the 404 above is scoping, not breakage)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/trips/${TRIP_OF_A.id}`)
      .set('Authorization', bearerFor(TRAVELER_A))
      .expect(200);
    expect(res.body).toMatchObject({ id: TRIP_OF_A.id });
  });

  it("AC-07: a traveler cannot modify another traveler's trip", async () => {
    await request(app.getHttpServer())
      .patch(`/trips/${TRIP_OF_A.id}`)
      .set('Authorization', bearerFor(TRAVELER_B))
      .send({ title: 'hijacked' })
      .expect(404);
  });

  it("AC-08: a traveler cannot delete another traveler's trip", async () => {
    await request(app.getHttpServer())
      .delete(`/trips/${TRIP_OF_A.id}`)
      .set('Authorization', bearerFor(TRAVELER_B))
      .expect(404);
  });

  it("AC-09: an admin is not exempt from ownership on a traveler's own routes", async () => {
    // The admin role grants admin *routes*, not a master key to other
    // travelers' trips through the traveler API.
    await request(app.getHttpServer())
      .get(`/trips/${TRIP_OF_A.id}`)
      .set('Authorization', bearerFor(ADMIN))
      .expect(404);
  });
});
