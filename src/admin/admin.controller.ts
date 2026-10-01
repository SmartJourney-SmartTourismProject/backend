import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { CurrentUser, Roles } from '../auth/index.js';
import { AdminAnalyticsService } from './admin-analytics.service.js';
import { AdminContentService } from './admin-content.service.js';
import { AdminEntryFeesService } from './admin-entry-fees.service.js';
import { AdminLlmService } from './admin-llm.service.js';
import { AdminUsersService } from './admin-users.service.js';
import { CreateEventDto } from './dto/create-event.dto.js';
import { CreateListingDto } from './dto/create-listing.dto.js';
import { EntryFeeQueryDto, RelinkEntryFeeDto } from './dto/entry-fee-query.dto.js';
import { SetLlmChainDto, SetLlmKeyDto } from './dto/llm.dto.js';
import { ModerationQueryDto } from './dto/moderation-query.dto.js';
import { RejectDto } from './dto/reject.dto.js';
import { BulkVerifyDto } from './dto/bulk-verify.dto.js';
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
    private readonly analytics: AdminAnalyticsService,
    private readonly entryFees: AdminEntryFeesService,
    private readonly llm: AdminLlmService,
  ) {}

  @Get('stats')
  stats() {
    return this.content.getStats();
  }

  /** SRS §3.1.14 - trends and breakdowns behind the analytics charts. */
  @Get('analytics')
  getAnalytics() {
    return this.analytics.getAnalytics();
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

  // Batch form of the route above, for a queue the admin has just reviewed.
  // Declared before ':id' routes would be ambiguous, so the literal path
  // segment 'verify-bulk' is used rather than an :id that could swallow it.
  @Post('listings/verify-bulk')
  verifyListingsBulk(@CurrentUser('id') adminId: string, @Body() dto: BulkVerifyDto) {
    return this.content.verifyListingsBulk(adminId, dto.ids);
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

  @Post('events/verify-bulk')
  verifyEventsBulk(@CurrentUser('id') adminId: string, @Body() dto: BulkVerifyDto) {
    return this.content.verifyEventsBulk(adminId, dto.ids);
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

  // ---- entry fees --------------------------------------------------------
  // Review queue for scraped heritage-site ticket prices (0012). A separate
  // status column, not is_verified/is_active - see AdminEntryFeesService.

  @Get('entry-fees')
  listEntryFees(@Query() query: EntryFeeQueryDto) {
    return this.entryFees.list(query);
  }

  @Get('entry-fees/:id')
  getEntryFee(@Param('id', ParseUUIDPipe) id: string) {
    return this.entryFees.get(id);
  }

  @Post('entry-fees/:id/approve')
  approveEntryFee(@CurrentUser('id') adminId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.entryFees.approve(adminId, id);
  }

  @Post('entry-fees/:id/reject')
  rejectEntryFee(@CurrentUser('id') adminId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.entryFees.reject(adminId, id);
  }

  @Patch('entry-fees/:id/listing')
  relinkEntryFee(
    @CurrentUser('id') adminId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RelinkEntryFeeDto,
  ) {
    return this.entryFees.relink(adminId, id, dto.listing_id);
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

  // ---- AI models (provider chain + API keys) ----------------------------

  @Get('llm')
  getLlmConfig() {
    return this.llm.getConfig();
  }

  @Put('llm/chain')
  setLlmChain(@CurrentUser('id') adminId: string, @Body() dto: SetLlmChainDto) {
    return this.llm.setChain(adminId, dto.chain);
  }

  @Put('llm/keys/:provider')
  setLlmKey(@CurrentUser('id') adminId: string, @Param('provider') provider: string, @Body() dto: SetLlmKeyDto) {
    return this.llm.setKey(adminId, provider, dto.key);
  }

  @Delete('llm/keys/:provider')
  clearLlmKey(@CurrentUser('id') adminId: string, @Param('provider') provider: string) {
    return this.llm.clearKey(adminId, provider);
  }

  @Post('llm/test')
  testLlm() {
    return this.llm.test();
  }
}
