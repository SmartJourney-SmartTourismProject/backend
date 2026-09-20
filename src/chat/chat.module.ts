import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { AiBackendService } from './ai-backend.service.js';
import { ChatController } from './chat.controller.js';
import { ChatService } from './chat.service.js';

@Module({
  imports: [HttpModule],
  controllers: [ChatController],
  providers: [ChatService, AiBackendService],
})
export class ChatModule {}
