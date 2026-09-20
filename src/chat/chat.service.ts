import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { AiBackendService } from './ai-backend.service.js';
import { SendMessageDto } from './dto/send-message.dto.js';

@Injectable()
export class ChatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiBackend: AiBackendService,
  ) {}

  createSession(userId: string, title?: string) {
    return this.prisma.chat_session.create({
      data: { user_id: userId, title: title ?? null },
    });
  }

  listSessions(userId: string) {
    return this.prisma.chat_session.findMany({
      where: { user_id: userId },
      orderBy: { updated_at: 'desc' },
    });
  }

  /**
   * Ownership check lives here rather than a guard: NotFoundException (not
   * Forbidden) on a session that exists but belongs to someone else, so a
   * caller can't distinguish "doesn't exist" from "not yours."
   */
  private async findOwnedSession(userId: string, id: string) {
    const session = await this.prisma.chat_session.findFirst({
      where: { id, user_id: userId },
    });
    if (!session) {
      throw new NotFoundException(`Chat session ${id} not found`);
    }
    return session;
  }

  async getSessionWithMessages(userId: string, id: string) {
    const session = await this.findOwnedSession(userId, id);
    const chat_message = await this.prisma.chat_message.findMany({
      where: { session_id: id },
      orderBy: { created_at: 'asc' },
    });
    return { ...session, chat_message };
  }

  async renameSession(userId: string, id: string, title: string) {
    await this.findOwnedSession(userId, id);
    return this.prisma.chat_session.update({
      where: { id },
      data: { title, updated_at: new Date() },
    });
  }

  async deleteSession(userId: string, id: string) {
    await this.findOwnedSession(userId, id);
    await this.prisma.chat_session.delete({ where: { id } });
    return { deleted: true };
  }

  /**
   * The core integration (AI_BACKEND_ENDPOINTS.md §"What NestJS should
   * persist"): persist the user's message, proxy to the AI backend, persist
   * the assistant's reply, and hand back the full plan so the client can
   * render itinerary/map/budget without a second round trip.
   */
  async sendMessage(userId: string, sessionId: string, dto: SendMessageDto) {
    const session = await this.findOwnedSession(userId, sessionId);

    await this.prisma.chat_message.create({
      data: { session_id: sessionId, role: 'user', content: dto.message },
    });

    const aiResponse = await this.aiBackend.planTrip({
      message: dto.message,
      user_id: userId,
      client_gps: dto.client_gps ?? null,
      // Omit on the first turn so the AI backend starts a fresh
      // conversation rather than treating an unset id as a real one.
      session_id: session.ai_session_id ?? undefined,
    });

    await this.prisma.chat_message.create({
      data: {
        session_id: sessionId,
        role: 'assistant',
        content: aiResponse.final_response ?? '',
        // Without this, reloading a session (refresh, or switching chats
        // and back) only had the rendered text to go on - the itinerary
        // summary card had nothing to rebuild itself from. Only stored
        // when there's an actual plan, not on a bare clarification reply.
        plan: aiResponse.itinerary.length > 0 ? (aiResponse as unknown as Prisma.InputJsonValue) : undefined,
      },
    });

    await this.prisma.chat_session.update({
      where: { id: sessionId },
      data: {
        // Only the first turn sets this - later turns keep reusing the
        // same ai_session_id so follow-ups stay in the same AI conversation.
        ai_session_id: session.ai_session_id ?? aiResponse.session_id,
        updated_at: new Date(),
      },
    });

    return aiResponse;
  }
}
