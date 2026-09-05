/**
 * Stand-in for `request.user.id` until auth (BACKEND_PLAN.md §7 Phase 2,
 * deliberately built last) exists. chat_session.user_id and itinerary.user_id
 * are both NOT NULL foreign keys, so chat/trips cannot persist anything
 * without a real user row - see backend/db/seeds/001_demo_user.sql.
 *
 * Once auth lands: replace every use of this constant with the id from the
 * JWT guard's request.user, and delete this file + the seed row.
 */
export const DEMO_USER_ID = '00000000-0000-0000-0000-000000000001';
