import { NotFoundException } from '@nestjs/common';
import { ChatService } from './chat.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { AiBackendService } from './ai-backend.service.js';

function makePrisma() {
  return {
    chat_session: { create: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn(), delete: vi.fn() },
    chat_message: { create: vi.fn(), findMany: vi.fn() },
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
