import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser, Roles } from '../auth/index.js';
import { AdminContentService } from './admin-content.service.js';
import { AdminUsersService } from './admin-users.service.js';
import { CreateEventDto } from './dto/create-event.dto.js';
import { CreateListingDto } from './dto/create-listing.dto.js';
import { ModerationQueryDto } from './dto/moderation-query.dto.js';
import { RejectDto } from './dto/reject.dto.js';
import { AdminUpdateUserDto } from './dto/update-user.dto.js';
import { UpdateEventDto } from './dto/update-event.dto.js';
import { UpdateListingDto } from './dto/update-listing.dto.js';
import { AdminUsersQueryDto } from './dto/users-query.dto.js';

/**
 * BACKEND_PLAN.md §5.7. `@Roles('admin')` on the class covers every route -
 * the global RolesGuard reads the Keycloak realm role from the token, so a
 * traveler gets 403 here even with a valid session.
 *
 * Unlike the public /listings and /events, these reads are NOT filtered to
 * verified rows: seeing what is waiting for review is the entire point.
 */
@Roles('admin')
@Controller('admin')
export class AdminController {
  constructor(
    private readonly content: AdminContentService,
    private readonly users: AdminUsersService,
  ) {}

  @Get('stats')
  stats() {
    return this.content.getStats();
  }

  // ---- listings --------------------------------------------------------

  @Get('listings')
  listListings(@Query() query: ModerationQueryDto) {
    return this.content.listListings(query);
  }

  @Get('listings/:id')
  getListing(@Param('id', ParseUUIDPipe) id: string) {
    return this.content.getListing(id);
  }

  @Post('listings')
  createListing(@CurrentUser('id') adminId: string, @Body() dto: CreateListingDto) {
    return this.content.createListing(adminId, dto);
  }

  @Patch('listings/:id')
  updateListing(
    @CurrentUser('id') adminId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateListingDto,
  ) {
    return this.content.updateListing(adminId, id, dto);
  }

  @Post('listings/:id/verify')
  verifyListing(@CurrentUser('id') adminId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.content.verifyListing(adminId, id);
  }

  @Post('listings/:id/reject')
  rejectListing(
    @CurrentUser('id') adminId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectDto,
  ) {
    return this.content.rejectListing(adminId, id, dto.reason);
  }

  @Delete('listings/:id')
  deleteListing(@CurrentUser('id') adminId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.content.deleteListing(adminId, id);
  }

  // ---- events ----------------------------------------------------------

  @Get('events')
  listEvents(@Query() query: ModerationQueryDto) {
    return this.content.listEvents(query);
  }

  @Get('events/:id')
  getEvent(@Param('id', ParseUUIDPipe) id: string) {
    return this.content.getEvent(id);
  }

  @Post('events')
  createEvent(@CurrentUser('id') adminId: string, @Body() dto: CreateEventDto) {
    return this.content.createEvent(adminId, dto);
  }

  @Patch('events/:id')
  updateEvent(
    @CurrentUser('id') adminId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateEventDto,
  ) {
    return this.content.updateEvent(adminId, id, dto);
  }

  @Post('events/:id/verify')
  verifyEvent(@CurrentUser('id') adminId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.content.verifyEvent(adminId, id);
  }

  @Post('events/:id/reject')
  rejectEvent(
    @CurrentUser('id') adminId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectDto,
  ) {
    return this.content.rejectEvent(adminId, id, dto.reason);
  }

  @Delete('events/:id')
  deleteEvent(@CurrentUser('id') adminId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.content.deleteEvent(adminId, id);
  }

  // ---- users -----------------------------------------------------------

  @Get('users')
  listUsers(@Query() query: AdminUsersQueryDto) {
    return this.users.list(query);
  }

  @Get('users/:id')
  getUser(@Param('id', ParseUUIDPipe) id: string) {
    return this.users.getById(id);
  }

  @Get('users/:id/activity')
  getUserActivity(@Param('id', ParseUUIDPipe) id: string) {
    return this.users.getActivity(id);
  }

  @Patch('users/:id')
  updateUser(
    @CurrentUser('id') adminId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdminUpdateUserDto,
  ) {
    return this.users.update(adminId, id, dto);
  }
}
