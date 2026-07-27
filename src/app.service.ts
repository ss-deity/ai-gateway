import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import OpenAI from 'openai';
import * as jwt from 'jsonwebtoken';
import { User } from './entities/user.entity.js';
import { Conversation } from './entities/conversation.entity.js';
import { Message } from './entities/message.entity.js';

const JWT_SECRET = process.env.JWT_SECRET || 'chatai_jwt_secret_2026';

export interface StreamCallbacks {
  onToken: (token: string) => void;
  onDone: () => void;
  onError: (error: Error) => void;
}

interface SessionState {
  abortController: AbortController;
  paused: boolean;
  buffer: string[];
  resumeResolve: (() => void) | null;
  conversationId: number | null;
}

@Injectable()
export class AppService {
  private readonly client = new OpenAI({
    apiKey: 'sk-664a40277262463cabca0f9aa2c6a2d8',
    baseURL: 'https://api.deepseek.com',
  });

  private sessions = new Map<string, SessionState>();
  private sessionCounter = 0;

  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(Conversation)
    private readonly conversationRepo: Repository<Conversation>,
    @InjectRepository(Message)
    private readonly messageRepo: Repository<Message>,
  ) {}

  getHello(): string {
    return 'Hello World!';
  }

  createSession(): string {
    const sessionId = `session_${++this.sessionCounter}_${Date.now()}`;
    this.sessions.set(sessionId, {
      abortController: new AbortController(),
      paused: false,
      buffer: [],
      resumeResolve: null,
      conversationId: null,
    });
    return sessionId;
  }

  cancelSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.abortController.abort();
      if (session.resumeResolve) {
        session.resumeResolve();
        session.resumeResolve = null;
      }
      this.sessions.delete(sessionId);
    }
  }

  pauseSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.paused = true;
      return true;
    }
    return false;
  }

  resumeSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.paused = false;
      if (session.resumeResolve) {
        session.resumeResolve();
        session.resumeResolve = null;
      }
      return true;
    }
    return false;
  }

  /**
   * 生成 JWT token
   */
  generateToken(user: User): string {
    return jwt.sign(
      { id: user.id, username: user.username },
      JWT_SECRET,
      { expiresIn: '7d' },
    );
  }

  /**
   * 注册用户
   */
  async register(username: string, password: string): Promise<User | null> {
    const existing = await this.userRepo.findOne({ where: { username } });
    if (existing) {
      return null;
    }
    const user = this.userRepo.create({ username, password, email: '' });
    return this.userRepo.save(user);
  }

  /**
   * 用户登录：验证账号密码
   */
  async login(username: string, password: string): Promise<User | null> {
    const user = await this.userRepo.findOne({ where: { username } });
    if (!user) {
      return null;
    }
    if (user.password !== password) {
      return null;
    }
    return user;
  }

  /**
   * 根据 ID 获取用户
   */
  async getUserById(id: number): Promise<User | null> {
    return this.userRepo.findOne({ where: { id } });
  }

  /**
   * 获取或创建默认用户（开发阶段用）
   */
  async getDefaultUser(): Promise<User> {
    let user = await this.userRepo.findOne({ where: { username: 'default' } });
    if (!user) {
      user = this.userRepo.create({ username: 'default', password: '', email: '' });
      user = await this.userRepo.save(user);
    }
    return user;
  }

  /**
   * 创建新会话
   */
  async createConversation(userId: number, title?: string): Promise<Conversation> {
    const conversation = this.conversationRepo.create({
      userId,
      title: title || '新对话',
    });
    return this.conversationRepo.save(conversation);
  }

  /**
   * 保存消息
   */
  async saveMessage(
    conversationId: number,
    role: 'user' | 'assistant',
    content: string,
  ): Promise<Message> {
    const message = this.messageRepo.create({ conversationId, role, content });
    return this.messageRepo.save(message);
  }

  /**
   * 获取用户所有会话列表
   */
  async getConversations(userId: number): Promise<Conversation[]> {
    return this.conversationRepo.find({
      where: { userId },
      order: { updatedAt: 'DESC' },
    });
  }

  /**
   * 获取会话的消息历史
   */
  async getMessages(conversationId: number): Promise<Message[]> {
    return this.messageRepo.find({
      where: { conversationId },
      order: { createdAt: 'ASC' },
    });
  }

  async chatStream(
    sessionId: string,
    message: string,
    callbacks: StreamCallbacks,
    conversationId?: number,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      callbacks.onError(new Error('Session not found'));
      return;
    }

    // 如果提供了 conversationId，保存用户消息
    if (conversationId) {
      session.conversationId = conversationId;
      await this.saveMessage(conversationId, 'user', message);
    }

    let fullResponse = '';

    try {
      const stream = await this.client.chat.completions.create(
        {
          model: 'deepseek-v4-flash',
          messages: [{ role: 'user', content: message }],
          stream: true,
        },
        { signal: session.abortController.signal },
      );

      for await (const chunk of stream) {
        if (session.abortController.signal.aborted) {
          break;
        }

        const content = chunk.choices[0]?.delta?.content;
        if (!content) continue;

        fullResponse += content;

        if (session.paused) {
          session.buffer.push(content);
          await new Promise<void>((resolve) => {
            if (!session.paused) {
              resolve();
              return;
            }
            session.resumeResolve = resolve;
          });

          if (session.abortController.signal.aborted) {
            break;
          }

          while (session.buffer.length > 0) {
            const bufferedToken = session.buffer.shift()!;
            callbacks.onToken(bufferedToken);
            await this.delay(30);
          }
          continue;
        }

        callbacks.onToken(content);
      }

      // 保存 assistant 完整回复
      if (conversationId && fullResponse) {
        await this.saveMessage(conversationId, 'assistant', fullResponse);
      }

      callbacks.onDone();
    } catch (e) {
      // 即使异常也尝试保存已有的回复
      if (conversationId && fullResponse) {
        await this.saveMessage(conversationId, 'assistant', fullResponse);
      }

      if ((e as Error).name === 'AbortError') {
        callbacks.onDone();
      } else {
        callbacks.onError(e as Error);
      }
    } finally {
      this.sessions.delete(sessionId);
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
