import { NotFoundException } from '@nestjs/common';
import { ChatService } from './chat.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { AiBackendService } from './ai-backend.service.js';

function makePrisma() {
  return {
    chat_session: { create: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn(), delete: vi.fn() },
    // findMany here backs the "only title from the FIRST plan" rule -
    // ChatService counts, in JS, how many of these have a non-empty
    // itinerary (a real plan, not a question turn's sources-only `plan`
    // row). Default: one prior row with a real plan, i.e. "this turn's
    // own plan is the only one so far".
    chat_message: {
      create: vi.fn(),
      findMany: vi.fn().mockResolvedValue([{ plan: { itinerary: [{ day: 1, items: [] }] } }]),
    },
    itinerary: { findMany: vi.fn(), deleteMany: vi.fn() },
  };
}

function makeAiBackend() {
  return { planTrip: vi.fn() };
}

describe('ChatService ownership', () => {
  it.each(['getSessionWithMessages', 'renameSession', 'deleteSession'] as const)(
    '%s throws NotFound for a session belonging to another user',
    async (method) => {
      const prisma = makePrisma();
      prisma.chat_session.findFirst.mockResolvedValue(null);
      const service = new ChatService(prisma as unknown as PrismaService, makeAiBackend() as unknown as AiBackendService);

      await expect((service[method] as (...a: unknown[]) => Promise<unknown>)('user-1', 'foreign-session', 'x')).rejects.toThrow(
        NotFoundException,
      );
    },
  );
});

describe('ChatService.getSessionWithMessages', () => {
  it('tags each message with the trip it was saved as, when one exists', async () => {
    const prisma = makePrisma();
    prisma.chat_session.findFirst.mockResolvedValue({ id: 'session-1' });
    prisma.chat_message.findMany.mockResolvedValue([
      { id: 'msg-1', role: 'assistant', content: 'here is your plan' },
    ]);
    prisma.itinerary.findMany.mockResolvedValue([{ id: 'trip-1', chat_message_id: 'msg-1' }]);
    const service = new ChatService(prisma as unknown as PrismaService, makeAiBackend() as unknown as AiBackendService);

    const result = await service.getSessionWithMessages('user-1', 'session-1');

    expect(result.chat_message[0]).toMatchObject({ id: 'msg-1', saved_trip_id: 'trip-1' });
  });

  it('leaves saved_trip_id null for a message that was never saved', async () => {
    const prisma = makePrisma();
    prisma.chat_session.findFirst.mockResolvedValue({ id: 'session-1' });
    prisma.chat_message.findMany.mockResolvedValue([{ id: 'msg-1', role: 'user', content: 'hi' }]);
    prisma.itinerary.findMany.mockResolvedValue([]);
    const service = new ChatService(prisma as unknown as PrismaService, makeAiBackend() as unknown as AiBackendService);

    const result = await service.getSessionWithMessages('user-1', 'session-1');

    expect(result.chat_message[0].saved_trip_id).toBeNull();
  });
});

describe('ChatService.deleteSession', () => {
  it('leaves saved trips untouched by default', async () => {
    const prisma = makePrisma();
    prisma.chat_session.findFirst.mockResolvedValue({ id: 'session-1' });
    const service = new ChatService(prisma as unknown as PrismaService, makeAiBackend() as unknown as AiBackendService);

    await service.deleteSession('user-1', 'session-1');

    expect(prisma.itinerary.deleteMany).not.toHaveBeenCalled();
    expect(prisma.chat_session.delete).toHaveBeenCalledWith({ where: { id: 'session-1' } });
  });

  it('also deletes trips saved from this session when asked to', async () => {
    const prisma = makePrisma();
    prisma.chat_session.findFirst.mockResolvedValue({ id: 'session-1' });
    prisma.chat_message.findMany.mockResolvedValue([{ id: 'msg-1' }]);
    const service = new ChatService(prisma as unknown as PrismaService, makeAiBackend() as unknown as AiBackendService);

    await service.deleteSession('user-1', 'session-1', true);

    expect(prisma.itinerary.deleteMany).toHaveBeenCalledWith({
      where: { user_id: 'user-1', chat_message_id: { in: ['msg-1'] } },
    });
  });
});

describe('ChatService.sendMessage', () => {
  it('omits session_id on the first turn but reuses it on later turns', async () => {
    const prisma = makePrisma();
    const aiBackend = makeAiBackend();
    prisma.chat_session.findFirst.mockResolvedValue({ id: 'session-1', ai_session_id: null });
    prisma.chat_message.create.mockResolvedValue({ id: 'assistant-msg-1' });
    aiBackend.planTrip.mockResolvedValue({ final_response: 'plan', itinerary: [], session_id: 'ai-session-1' });
    const service = new ChatService(prisma as unknown as PrismaService, aiBackend as unknown as AiBackendService);

    await service.sendMessage('user-1', 'session-1', { message: 'plan a trip' });

    expect(aiBackend.planTrip).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'user-1', session_id: undefined }),
    );
    expect(prisma.chat_session.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ ai_session_id: 'ai-session-1' }) }),
    );
  });

  it('does not persist a plan on a bare clarification reply', async () => {
    const prisma = makePrisma();
    const aiBackend = makeAiBackend();
    prisma.chat_session.findFirst.mockResolvedValue({ id: 'session-1', ai_session_id: 'ai-session-1' });
    prisma.chat_message.create.mockResolvedValue({ id: 'assistant-msg-1' });
    aiBackend.planTrip.mockResolvedValue({ final_response: 'which city?', itinerary: [], session_id: 'ai-session-1' });
    const service = new ChatService(prisma as unknown as PrismaService, aiBackend as unknown as AiBackendService);

    await service.sendMessage('user-1', 'session-1', { message: 'plan a trip' });

    const assistantCreateCall = prisma.chat_message.create.mock.calls[1][0];
    expect(assistantCreateCall.data.plan).toBeUndefined();
  });
});

describe('ChatService.sendMessage session titles', () => {
  /**
   * The sidebar used to show the first 60 characters of whatever the traveler
   * typed, so two people asking for the same trip in different words got two
   * unrecognisable rows ("i want to go to galle to kan...") that search could
   * not tell apart. The title is now built from the plan.
   */
  function planResponse(over: Record<string, unknown> = {}) {
    return {
      final_response: 'plan',
      session_id: 'ai-session-1',
      itinerary: [{ day: 1, items: [] }],
      destination: 'Kandy District',
      start_location: null,
      ...over,
    };
  }

  async function titleFrom(aiPlan: Record<string, unknown>, priorPlans = 1) {
    const prisma = makePrisma();
    const aiBackend = makeAiBackend();
    prisma.chat_session.findFirst.mockResolvedValue({ id: 'session-1', ai_session_id: 'ai-session-1' });
    prisma.chat_message.create.mockResolvedValue({ id: 'assistant-msg-1' });
    // `priorPlans` real-plan rows (a non-empty itinerary each) - what
    // ChatService's JS filter counts, not a raw row count.
    prisma.chat_message.findMany.mockResolvedValue(
      Array.from({ length: priorPlans }, () => ({ plan: { itinerary: [{ day: 1, items: [] }] } })),
    );
    aiBackend.planTrip.mockResolvedValue(aiPlan);
    const service = new ChatService(prisma as unknown as PrismaService, aiBackend as unknown as AiBackendService);

    await service.sendMessage('user-1', 'session-1', { message: 'anything' });

    return prisma.chat_session.update.mock.calls[0][0].data.title;
  }

  it('names the trip after its destination and length', async () => {
    expect(await titleFrom(planResponse())).toBe('Kandy · 1 day');
  });

  it('includes the origin when the traveler named one', async () => {
    const title = await titleFrom(
      planResponse({
        start_location: { lat: 6.03, lon: 80.21, source: 'text', name: 'Galle' },
        itinerary: [{ day: 1, items: [] }, { day: 2, items: [] }],
      }),
    );
    expect(title).toBe('Galle → Kandy · 2 days');
  });

  it('drops the "District" suffix, which every row would otherwise carry', async () => {
    expect(await titleFrom(planResponse({ destination: 'Colombo District' }))).toBe('Colombo · 1 day');
  });

  it('does not repeat the place when the origin equals the destination', async () => {
    const title = await titleFrom(
      planResponse({ start_location: { lat: 7.29, lon: 80.63, source: 'text', name: 'Kandy' } }),
    );
    expect(title).toBe('Kandy · 1 day');
  });

  it('leaves the title alone on a clarification turn with no destination', async () => {
    // Overwriting a good title with a worse one is the failure to avoid here.
    expect(await titleFrom(planResponse({ destination: null, itinerary: [] }))).toBeUndefined();
  });

  it('only titles from the first plan, so a follow-up cannot rename the chat', async () => {
    expect(await titleFrom(planResponse(), 3)).toBeUndefined();
  });

  it('a prior sources-only (question) turn does not count against the naming budget', async () => {
    // Regression: `plan` is now also stored for a pure-question turn (for
    // its citations), which used to make it count as a "prior plan" too -
    // a visa question asked before the first real itinerary would then
    // block that itinerary from ever naming the session.
    const prisma = makePrisma();
    const aiBackend = makeAiBackend();
    prisma.chat_session.findFirst.mockResolvedValue({ id: 'session-1', ai_session_id: 'ai-session-1' });
    prisma.chat_message.create.mockResolvedValue({ id: 'assistant-msg-1' });
    // One prior row exists, but its itinerary is empty (a question turn) -
    // must not be counted as a real plan.
    prisma.chat_message.findMany.mockResolvedValue([{ plan: { itinerary: [] } }]);
    aiBackend.planTrip.mockResolvedValue(planResponse());
    const service = new ChatService(prisma as unknown as PrismaService, aiBackend as unknown as AiBackendService);

    await service.sendMessage('user-1', 'session-1', { message: 'plan a trip to Kandy' });

    expect(prisma.chat_session.update.mock.calls[0][0].data.title).toBe('Kandy · 1 day');
  });
});

describe('ChatService.sendMessage persists sources-only responses', () => {
  it('stores `plan` for a question turn with sources but no itinerary, so citations survive a reload', async () => {
    const prisma = makePrisma();
    const aiBackend = makeAiBackend();
    prisma.chat_session.findFirst.mockResolvedValue({ id: 'session-1', ai_session_id: 'ai-session-1' });
    prisma.chat_message.create.mockResolvedValue({ id: 'assistant-msg-1' });
    aiBackend.planTrip.mockResolvedValue({
      final_response: 'Cover your shoulders and knees [1].',
      itinerary: [],
      session_id: 'ai-session-1',
      sources: [{ title: 'Temple dress code', url: 'https://x', section: 'General rule', license: 'internal' }],
    });
    const service = new ChatService(prisma as unknown as PrismaService, aiBackend as unknown as AiBackendService);

    await service.sendMessage('user-1', 'session-1', { message: 'what should I wear at a temple?' });

    const assistantCreateCall = prisma.chat_message.create.mock.calls[1][0];
    expect(assistantCreateCall.data.plan).toBeDefined();
    expect((assistantCreateCall.data.plan as { sources: unknown[] }).sources).toHaveLength(1);
  });

  it('still omits `plan` when there is neither an itinerary nor sources (a bare clarification)', async () => {
    const prisma = makePrisma();
    const aiBackend = makeAiBackend();
    prisma.chat_session.findFirst.mockResolvedValue({ id: 'session-1', ai_session_id: 'ai-session-1' });
    prisma.chat_message.create.mockResolvedValue({ id: 'assistant-msg-1' });
    aiBackend.planTrip.mockResolvedValue({ final_response: 'which city?', itinerary: [], session_id: 'ai-session-1' });
    const service = new ChatService(prisma as unknown as PrismaService, aiBackend as unknown as AiBackendService);

    await service.sendMessage('user-1', 'session-1', { message: 'plan a trip' });

    const assistantCreateCall = prisma.chat_message.create.mock.calls[1][0];
    expect(assistantCreateCall.data.plan).toBeUndefined();
  });
});

describe('ChatService.sendMessage itinerary photos', () => {
  function setup(listingsResult: unknown) {
    const prisma = makePrisma() as ReturnType<typeof makePrisma> & { travel_listing: { findMany: ReturnType<typeof vi.fn> } };
    prisma.travel_listing = { findMany: vi.fn() };
    if (listingsResult instanceof Error) prisma.travel_listing.findMany.mockRejectedValue(listingsResult);
    else prisma.travel_listing.findMany.mockResolvedValue(listingsResult);
    const aiBackend = makeAiBackend();
    prisma.chat_session.findFirst.mockResolvedValue({ id: 'session-1', ai_session_id: 'ai-session-1' });
    prisma.chat_message.create.mockResolvedValue({ id: 'assistant-msg-1' });
    aiBackend.planTrip.mockResolvedValue({
      final_response: 'plan',
      session_id: 'ai-session-1',
      destination: 'Kandy',
      start_location: null,
      itinerary: [
        {
          day: 1,
          items: [
            { type: 'hotel', name: 'Forest Villa', lat: 7.3, lon: 80.6, listing_id: 'l-hotel' },
            { type: 'restaurant', name: 'Cafe', lat: 7.3, lon: 80.6, listing_id: 'l-cafe' },
          ],
        },
      ],
    });
    const service = new ChatService(prisma as unknown as PrismaService, aiBackend as unknown as AiBackendService);
    return { prisma, service };
  }

  it('attaches each stop\'s photo (and credit) before storing the reply', async () => {
    const { prisma, service } = setup([
      { id: 'l-hotel', photo_url: 'https://img/h.jpg', listing_image: [{ url: 'https://img/h.jpg', attribution: 'CC BY-SA' }] },
      { id: 'l-cafe', photo_url: null, listing_image: [] },
    ]);

    const result = await service.sendMessage('user-1', 'session-1', { message: 'plan kandy' });

    const [hotel, cafe] = result.itinerary[0].items;
    expect(hotel.photo_url).toBe('https://img/h.jpg');
    expect(hotel.photo_attribution).toBe('CC BY-SA');
    expect(cafe.photo_url).toBeUndefined();
    // Stored with the message, so a reloaded chat still has them.
    const stored = prisma.chat_message.create.mock.calls[1][0].data.plan as { itinerary: { items: { photo_url?: string }[] }[] };
    expect(stored.itinerary[0].items[0].photo_url).toBe('https://img/h.jpg');
    expect(prisma.travel_listing.findMany).toHaveBeenCalledTimes(1);
  });

  it('a failed photo lookup never fails the reply', async () => {
    const { service } = setup(new Error('db down'));
    const result = await service.sendMessage('user-1', 'session-1', { message: 'plan kandy' });
    expect(result.final_response).toBe('plan');
    expect(result.itinerary[0].items[0].photo_url).toBeUndefined();
  });
});
