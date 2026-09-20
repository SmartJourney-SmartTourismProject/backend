import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ChatService } from './chat.service.js';
import { CreateSessionDto } from './dto/create-session.dto.js';
import { RenameSessionDto } from './dto/rename-session.dto.js';
import { SendMessageDto } from './dto/send-message.dto.js';

@Controller('chat/sessions')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Post()
  create(@Body() dto: CreateSessionDto) {
    return this.chatService.createSession(dto.title);
  }

  @Get()
  findAll() {
    return this.chatService.listSessions();
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.chatService.getSessionWithMessages(id);
  }

  @Post(':id/messages')
  sendMessage(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SendMessageDto) {
    return this.chatService.sendMessage(id, dto);
  }

  @Patch(':id')
  rename(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RenameSessionDto) {
    return this.chatService.renameSession(id, dto.title);
  }

  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.chatService.deleteSession(id);
  }
}
