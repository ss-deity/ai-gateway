import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { UploadModule } from './upload/upload.module.js';
import { ImageModule } from './image/image.module.js';
import { ModelsModule } from './models/models.module.js';
import { User, Conversation, Message } from './entities/index.js';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'mysql',
      host: process.env.DB_HOST || 'localhost',
      port: Number(process.env.DB_PORT) || 3306,
      username: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'chat_ai',
      entities: [User, Conversation, Message],
      synchronize: true,
    }),
    TypeOrmModule.forFeature([User, Conversation, Message]),
    UploadModule,
    ImageModule,
    ModelsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
