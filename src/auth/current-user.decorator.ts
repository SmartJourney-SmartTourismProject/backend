import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AuthenticatedUser } from '../users/users.service.js';

/**
 * The provisioned app_user for the caller (see UsersService.ensureFromToken).
 * `@CurrentUser() user` gives the whole record; `@CurrentUser('id') id` just
 * one field - which is what the services key their ownership checks on.
 */
export const CurrentUser = createParamDecorator(
  (field: keyof AuthenticatedUser | undefined, ctx: ExecutionContext) => {
    const user = ctx.switchToHttp().getRequest<{ user: AuthenticatedUser }>().user;
    return field ? user[field] : user;
  },
);
