// class-transformer/class-validator read design-time types through
// reflect-metadata, which Nest loads at bootstrap; a standalone DTO test
// has no bootstrap, so it is imported here explicitly.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateEventDto } from './create-event.dto.js';
import { CreateListingDto } from './create-listing.dto.js';
import { UpdateListingDto } from './update-listing.dto.js';

/**
 * INPUT VALIDATION on the admin write path.
 *
 * The service tests one layer down assume the DTO already refused anything
 * malformed. That assumption is only worth making if it is checked, so these
 * cases drive the same decorators the global ValidationPipe runs in production
 * (`transform`, `whitelist`, `forbidNonWhitelisted` - see main.ts).
 *
 * An admin is a trusted role, but "trusted" is not "infallible": a compromised
 * or careless admin account is exactly the threat that makes stored XSS and
 * unbounded writes worth refusing at the boundary rather than in the UI.
 */

const VALID_LISTING = {
  name: 'Temple of the Tooth',
  district_id: '3f1a6c2e-8b4d-4f7a-9c21-5ad0e7b91c44',
  category_id: '7c2b9d1a-4e6f-4a8b-9d30-1bc4f8e02a55',
  latitude: 7.2936,
  longitude: 80.6413,
};

async function errorsFor<T extends object>(cls: new () => T, payload: object): Promise<string[]> {
  const dto = plainToInstance(cls, payload);
  const errors = await validate(dto as object, { whitelist: true, forbidNonWhitelisted: true });
  return errors.map((e) => e.property);
}

describe('CreateListingDto — coordinates', () => {
  it('accepts a well-formed listing', async () => {
    expect(await errorsFor(CreateListingDto, VALID_LISTING)).toEqual([]);
  });

  it('rejects a latitude outside the range Postgres will accept as a geography point', async () => {
    // location is geography(Point,4326) and NOT NULL; an out-of-range value
    // reaches ST_MakePoint and fails in the database instead of at the edge.
    expect(await errorsFor(CreateListingDto, { ...VALID_LISTING, latitude: 999 })).toContain('latitude');
  });

  it('rejects a longitude outside range', async () => {
    expect(await errorsFor(CreateListingDto, { ...VALID_LISTING, longitude: -200 })).toContain('longitude');
  });

  it('requires coordinates, because the column is NOT NULL', async () => {
    const { latitude: _lat, longitude: _lon, ...withoutCoords } = VALID_LISTING;
    const missing = await errorsFor(CreateListingDto, withoutCoords);
    expect(missing).toEqual(expect.arrayContaining(['latitude', 'longitude']));
  });
});

describe('UpdateListingDto — photo_url', () => {
  it('accepts an ordinary https image URL', async () => {
    expect(await errorsFor(UpdateListingDto, { photo_url: 'https://cdn.example.com/kandy.jpg' })).toEqual([]);
  });

  it('rejects a javascript: URI, which would be stored XSS once rendered into an href', async () => {
    expect(await errorsFor(UpdateListingDto, { photo_url: 'javascript:alert(document.cookie)' })).toContain(
      'photo_url',
    );
  });

  it('rejects a data: URI carrying markup', async () => {
    expect(
      await errorsFor(UpdateListingDto, { photo_url: 'data:text/html,<script>alert(1)</script>' }),
    ).toContain('photo_url');
  });

  it('rejects a bare string that is not a URL at all', async () => {
    expect(await errorsFor(UpdateListingDto, { photo_url: 'not a url' })).toContain('photo_url');
  });
});

describe('UpdateListingDto — bounded input', () => {
  it('accepts a reasonable tag list', async () => {
    expect(await errorsFor(UpdateListingDto, { tags: ['culture', 'heritage'] })).toEqual([]);
  });

  it('refuses an oversized tag array rather than writing it to the row', async () => {
    const tooMany = Array.from({ length: 21 }, (_, i) => `tag-${i}`);
    expect(await errorsFor(UpdateListingDto, { tags: tooMany })).toContain('tags');
  });

  it('refuses a single tag long enough to be a payload rather than a tag', async () => {
    expect(await errorsFor(UpdateListingDto, { tags: ['x'.repeat(200)] })).toContain('tags');
  });

  it('caps the free-text description', async () => {
    expect(await errorsFor(UpdateListingDto, { description: 'x'.repeat(2001) })).toContain('description');
  });
});

describe('UpdateListingDto — currency', () => {
  it('accepts an ISO 4217 code', async () => {
    expect(await errorsFor(UpdateListingDto, { currency: 'LKR' })).toEqual([]);
  });

  it.each(['lkr', 'L\nKR', '$$$', 'LKRR'])('rejects %j', async (currency) => {
    expect(await errorsFor(UpdateListingDto, { currency })).toContain('currency');
  });
});

describe('CreateEventDto', () => {
  const VALID_EVENT = {
    name: 'Kandy Esala Perahera',
    district_id: '3f1a6c2e-8b4d-4f7a-9c21-5ad0e7b91c44',
    start_datetime: '2026-08-01T18:00:00.000Z',
  };

  it('accepts a well-formed event', async () => {
    expect(await errorsFor(CreateEventDto, VALID_EVENT)).toEqual([]);
  });

  it('rejects a start_datetime that is not a date', async () => {
    expect(await errorsFor(CreateEventDto, { ...VALID_EVENT, start_datetime: 'next tuesday' })).toContain(
      'start_datetime',
    );
  });

  it('rejects a district_id that is not a UUID', async () => {
    expect(await errorsFor(CreateEventDto, { ...VALID_EVENT, district_id: "1 OR 1=1" })).toContain(
      'district_id',
    );
  });

  it('bounds the tag list here too', async () => {
    const tooMany = Array.from({ length: 21 }, (_, i) => `t-${i}`);
    expect(await errorsFor(CreateEventDto, { ...VALID_EVENT, tags: tooMany })).toContain('tags');
  });
});
