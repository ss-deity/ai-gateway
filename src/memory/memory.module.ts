import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Conversation } from '../entities/conversation.entity.js';
import { Message } from '../entities/message.entity.js';
import { MemoryService } from './memory.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([Conversation, Message])],
  providers: [MemoryService],
  exports: [MemoryService],
})
export class MemoryModule {}
