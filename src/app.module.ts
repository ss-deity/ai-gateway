import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { User, Conversation, Message } from './entities/index.js';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'mysql',
      host: process.env.DB_HOST || '114.55.30.207',
      port: Number(process.env.DB_PORT) || 3306,
      username: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || 'ChatAI@2026',
      database: process.env.DB_NAME || 'chat_ai',
      entities: [User, Conversation, Message],
      synchronize: true, // 开发环境自动同步表结构，生产环境应关闭
    }),
    TypeOrmModule.forFeature([User, Conversation, Message]),
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
