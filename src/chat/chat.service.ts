import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { AiBackendService } from './ai-backend.service.js';
import { SendMessageDto } from './dto/send-message.dto.js';
import type { AiTripPlanResponse } from './ai-backend.types.js';

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

    // A saved trip's chat_message_id is what lets the chat card know it was
    // already saved (see trips.service.saveTrip) - without reporting it back
    // here, every reload forgot the card's saved state and let it be
    // "Save itinerary"'d again into a duplicate.
    const savedTrips = await this.prisma.itinerary.findMany({
      where: { chat_message_id: { in: chat_message.map((m) => m.id) } },
      select: { id: true, chat_message_id: true },
    });
    const savedTripByMessageId = new Map(savedTrips.map((t) => [t.chat_message_id, t.id]));

    return {
      ...session,
      chat_message: chat_message.map((m) => ({
        ...m,
        saved_trip_id: savedTripByMessageId.get(m.id) ?? null,
      })),
    };
  }

  async renameSession(userId: string, id: string, title: string) {
    await this.findOwnedSession(userId, id);
    return this.prisma.chat_session.update({
      where: { id },
      data: { title, updated_at: new Date() },
    });
  }

  /**
   * deleteSavedItineraries opts into also removing any trips saved from this
   * session's messages. Without it, the chat_message rows just cascade away
   * and itinerary.chat_message_id is SetNull on the saved trips - they
   * survive, unlinked, in Saved Itineraries. That's the default (a chat
   * delete shouldn't silently take saved trips with it) - this is only for
   * when the user explicitly ticks the "also delete related saved
   * itineraries" box.
   */
  async deleteSession(userId: string, id: string, deleteSavedItineraries = false) {
    await this.findOwnedSession(userId, id);
    if (deleteSavedItineraries) {
      const messages = await this.prisma.chat_message.findMany({
        where: { session_id: id },
        select: { id: true },
      });
      await this.prisma.itinerary.deleteMany({
        where: { user_id: userId, chat_message_id: { in: messages.map((m) => m.id) } },
      });
    }
    await this.prisma.chat_session.delete({ where: { id } });
    return { deleted: true };
  }

  /**
   * A searchable name for the conversation, built from the plan itself.
   *
   * The old title was the first message truncated to 60 characters, which
   * produced a sidebar of near-identical rows ("i want to go to galle to
   * kan...", twice) that could be neither told apart nor searched: the useful
   * words were past the cut, and phrasing varies between people asking for
   * the same trip. A plan already knows where the trip goes, how long it is,
   * and now where it departs from, so the title is derived from that.
   *
   * Returns null when there is nothing better than what the session already
   * has - a clarification turn with no destination should not overwrite a
   * good title with a worse one.
   */
  private planTitle(aiResponse: AiTripPlanResponse): string | null {
    const destination = aiResponse.destination?.trim();
    if (!destination) return null;

    // "District" is on every district name in the catalogue and carries no
    // information in a sidebar where every row is a district.
    const shorten = (place: string) => place.replace(/\s+District$/i, '').trim();

    const origin = aiResponse.start_location?.name?.trim();
    const route =
      origin && shorten(origin).toLowerCase() !== shorten(destination).toLowerCase()
        ? `${shorten(origin)} → ${shorten(destination)}`
        : shorten(destination);

    const days = aiResponse.itinerary.length;
    return days > 0 ? `${route} · ${days} day${days === 1 ? '' : 's'}` : route;
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

    const assistantMessage = await this.prisma.chat_message.create({
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

    // Named from the FIRST plan only. Re-titling on every turn would make a
    // follow-up ("make it cheaper") rewrite the name of a conversation the
    // user may since have renamed by hand, and a session's identity in the
    // sidebar should not keep moving underneath them.
    const priorPlans = await this.prisma.chat_message.count({
      where: { session_id: sessionId, role: 'assistant', plan: { not: Prisma.DbNull } },
    });
    const derivedTitle = priorPlans <= 1 ? this.planTitle(aiResponse) : null;

    await this.prisma.chat_session.update({
      where: { id: sessionId },
      data: {
        // Only the first turn sets this - later turns keep reusing the
        // same ai_session_id so follow-ups stay in the same AI conversation.
        ai_session_id: session.ai_session_id ?? aiResponse.session_id,
        ...(derivedTitle ? { title: derivedTitle } : {}),
        updated_at: new Date(),
      },
    });

    // Handed back so the client can tag the itinerary card with the message
    // it came from - required for the save button to be idempotent (see
    // trips.service.saveTrip's chat_message_id dedupe).
    return { ...aiResponse, chat_message_id: assistantMessage.id };
  }
}
