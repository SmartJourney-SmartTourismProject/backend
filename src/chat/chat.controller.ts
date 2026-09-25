import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../auth/index.js';
import { ChatService } from './chat.service.js';
import { CreateSessionDto } from './dto/create-session.dto.js';
import { RenameSessionDto } from './dto/rename-session.dto.js';
import { SendMessageDto } from './dto/send-message.dto.js';

@Controller('chat/sessions')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Post()
  create(@CurrentUser('id') userId: string, @Body() dto: CreateSessionDto) {
    return this.chatService.createSession(userId, dto.title);
  }

  @Get()
  findAll(@CurrentUser('id') userId: string) {
    return this.chatService.listSessions(userId);
  }

  @Get(':id')
  findOne(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.chatService.getSessionWithMessages(userId, id);
  }

  @Post(':id/messages')
  sendMessage(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SendMessageDto,
  ) {
    return this.chatService.sendMessage(userId, id, dto);
  }

  @Patch(':id')
  rename(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RenameSessionDto,
  ) {
    return this.chatService.renameSession(userId, id, dto.title);
  }

  @Delete(':id')
  remove(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('deleteSaved') deleteSaved?: string,
  ) {
    return this.chatService.deleteSession(userId, id, deleteSaved === 'true');
  }
}
