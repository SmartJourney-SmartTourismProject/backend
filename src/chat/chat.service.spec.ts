import { NotFoundException } from '@nestjs/common';
import { ChatService } from './chat.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { AiBackendService } from './ai-backend.service.js';

function makePrisma() {
  return {
    chat_session: { create: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn(), delete: vi.fn() },
    // count backs the "only title from the FIRST plan" rule; 1 means this
    // turn's own plan is the only one so far.
    chat_message: { create: vi.fn(), findMany: vi.fn(), count: vi.fn().mockResolvedValue(1) },
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
    prisma.chat_message.count.mockResolvedValue(priorPlans);
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
});
