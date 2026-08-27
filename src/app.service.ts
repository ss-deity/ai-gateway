import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import * as jwt from 'jsonwebtoken';
import { User } from './entities/user.entity.js';
import { Conversation } from './entities/conversation.entity.js';
import { Message } from './entities/message.entity.js';
import { UploadService } from './upload/upload.service.js';
import { ModelsService } from './models/models.service.js';
import { SkillsService } from './skills/skills.service.js';
import { MemoryService } from './memory/memory.service.js';
import type {
  Attachment,
  ChatHistoryMessage,
  ToolCallFrame,
} from './models/model.types.js';
import type { ChartArtifact } from './charts/chart.types.js';
import type { FlowchartArtifact } from './flowcharts/flowchart.types.js';

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-env';

export interface StreamCallbacks {
  onToken: (token: string) => void;
  onImages?: (images: string[]) => void;
  /** 工具调用状态变化（正在执行 / 执行完成） */
  onTool?: (tool: ToolCallFrame) => void;
  /** 工具产出的 ECharts 图表 */
  onCharts?: (charts: ChartArtifact[]) => void;
  /** 工具产出的流程图 */
  onFlowcharts?: (flowcharts: FlowchartArtifact[]) => void;
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
  private readonly logger = new Logger(AppService.name);

  private sessions = new Map<string, SessionState>();
  private sessionCounter = 0;

  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(Conversation)
    private readonly conversationRepo: Repository<Conversation>,
    @InjectRepository(Message)
    private readonly messageRepo: Repository<Message>,
    private readonly uploadService: UploadService,
    private readonly modelsService: ModelsService,
    private readonly skillsService: SkillsService,
    private readonly memoryService: MemoryService,
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
    return jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, {
      expiresIn: '7d',
    });
  }

  /**
   * 注册用户：
   *   - 生成稳定的业务 uid（UUID）
   *   - nickname 默认与登录账号一致
   *   - 注册成功后异步为该用户在 BOS 创建独立目录 users/<uid>/
   */
  async register(username: string, password: string): Promise<User | null> {
    const existing = await this.userRepo.findOne({ where: { username } });
    if (existing) {
      return null;
    }
    const user = this.userRepo.create({
      username,
      nickname: username,
      password,
      email: '',
      uid: randomUUID(),
    });
    const saved = await this.userRepo.save(user);

    // 为新用户创建 BOS 独立存储目录；失败不阻断注册，仅记录日志，
    // 后续用户首次上传时如果目录仍不存在会自动创建（uploadService 内部靠 prefix 生效）。
    try {
      await this.uploadService.createUserFolder(saved.uid);
    } catch (err) {
      this.logger.warn(
        `注册后创建 BOS 用户目录失败 uid=${saved.uid}: ${(err as Error).message}`,
      );
    }

    return saved;
  }

  /**
   * 用户登录：验证账号密码。
   * 兼容旧数据：若该用户没有 uid（老账号），登录时补发一个并异步创建 BOS 目录。
   */
  async login(username: string, password: string): Promise<User | null> {
    const user = await this.userRepo.findOne({ where: { username } });
    if (!user) {
      return null;
    }
    if (user.password !== password) {
      return null;
    }
    // 老账号补 uid
    if (!user.uid) {
      user.uid = randomUUID();
      await this.userRepo.save(user);
      try {
        await this.uploadService.createUserFolder(user.uid);
      } catch (err) {
        this.logger.warn(
          `为老账号补建 BOS 目录失败 uid=${user.uid}: ${(err as Error).message}`,
        );
      }
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
   * 更新用户信息（仅名称 nickname 和头像 avatar；登录账号 username 不可修改）
   */
  async updateUser(
    id: number,
    patch: { nickname?: string; avatar?: string },
  ): Promise<User | null> {
    const user = await this.userRepo.findOne({ where: { id } });
    if (!user) {
      return null;
    }

    if (patch.nickname !== undefined) {
      const nextName = patch.nickname.trim();
      if (nextName) {
        user.nickname = nextName;
      }
    }

    if (patch.avatar !== undefined) {
      user.avatar = patch.avatar;
    }

    return this.userRepo.save(user);
  }

  /**
   * 获取或创建默认用户（开发阶段用）
   */
  async getDefaultUser(): Promise<User> {
    let user = await this.userRepo.findOne({ where: { username: 'default' } });
    if (!user) {
      user = this.userRepo.create({
        username: 'default',
        password: '',
        email: '',
      });
      user = await this.userRepo.save(user);
    }
    return user;
  }

  /**
   * 创建新会话
   */
  async createConversation(
    userId: number,
    title?: string,
  ): Promise<Conversation> {
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
    images?: string[],
    model?: string,
    attachments?: Attachment[],
    toolCalls?: ToolCallFrame[],
    charts?: ChartArtifact[],
    flowcharts?: FlowchartArtifact[],
  ): Promise<Message> {
    const message = this.messageRepo.create({
      conversationId,
      role,
      content,
      images: images && images.length ? images : undefined,
      attachments: attachments && attachments.length ? attachments : undefined,
      model,
      // 落库时统一改成 done：本轮已结束，历史回显不该再出现「正在执行」
      toolCalls: toolCalls?.length
        ? toolCalls.map((t) => ({ ...t, status: 'done' as const }))
        : undefined,
      charts: charts && charts.length ? charts : undefined,
      flowcharts: flowcharts && flowcharts.length ? flowcharts : undefined,
    });
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

  /**
   * 删除会话及其所有消息
   */
  async deleteConversation(conversationId: number): Promise<boolean> {
    const conversation = await this.conversationRepo.findOne({
      where: { id: conversationId },
    });
    if (!conversation) {
      return false;
    }
    await this.messageRepo.delete({ conversationId });
    await this.conversationRepo.delete({ id: conversationId });
    return true;
  }

  /**
   * 重命名会话标题
   */
  async updateConversationTitle(
    conversationId: number,
    title: string,
  ): Promise<Conversation | null> {
    const conversation = await this.conversationRepo.findOne({
      where: { id: conversationId },
    });
    if (!conversation) return null;
    const next = title.trim();
    if (next) conversation.title = next.slice(0, 255);
    return this.conversationRepo.save(conversation);
  }

  /**
   * 触碰会话：把 updatedAt 更新为当前时间（用于"每次会话结束存当前时间"，
   * 使会话按最近活跃时间排序）。
   */
  async touchConversation(conversationId: number): Promise<void> {
    await this.conversationRepo.update(conversationId, {
      updatedAt: new Date(),
    });
  }

  async chatStream(
    sessionId: string,
    message: string,
    callbacks: StreamCallbacks,
    conversationId?: number,
    modelType?: string,
    thinking?: boolean,
    attachments?: Attachment[],
    skills?: string[],
    userId?: number,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      callbacks.onError(new Error('Session not found'));
      return;
    }

    // 会话记忆：必须在保存本次用户消息之前取，否则「最近 N 条」会把当前提问算进去
    let memory: string | undefined;
    let history: ChatHistoryMessage[] = [];
    if (conversationId) {
      const loaded = await this.memoryService.load(conversationId);
      memory = loaded.memory;
      history = loaded.history;
    }

    // 如果提供了 conversationId，保存用户消息
    if (conversationId) {
      session.conversationId = conversationId;
      await this.saveMessage(
        conversationId,
        'user',
        message,
        undefined,
        undefined,
        attachments,
      );
    }

    const provider = this.modelsService.getProvider(modelType);
    // 前端 `/` 唤起的技能：翻译成 system prompt 下发，模型据此约束输出
    const system = this.skillsService.buildSystemPrompt(skills);
    let fullText = '';
    const images: string[] = [];
    /** 本轮发生过的工具调用（按 id 去重，状态取最后一次） */
    const toolCalls: ToolCallFrame[] = [];
    /** 本轮工具产出的图表，随消息落库用于历史回显 */
    const charts: ChartArtifact[] = [];
    /** 本轮工具产出的流程图，随消息落库用于历史回显 */
    const flowcharts: FlowchartArtifact[] = [];

    try {
      await provider.run(
        {
          message,
          signal: session.abortController.signal,
          thinking,
          attachments,
          system,
          userId,
          history,
          memory,
        },
        {
          onDelta: async (delta) => {
            // 文本增量：支持暂停（暂停时阻塞，恢复后继续）
            if (delta.content) {
              if (session.paused) {
                await new Promise<void>((resolve) => {
                  session.resumeResolve = resolve;
                });
              }
              if (session.abortController.signal.aborted) return;
              fullText += delta.content;
              callbacks.onToken(delta.content);
            }
            // 图片增量：统一回传
            if (delta.images && delta.images.length) {
              images.push(...delta.images);
              callbacks.onImages?.(delta.images);
            }
            // 工具调用状态：同一个 id 只保留最新状态，供前端与历史回显使用
            if (delta.tool) {
              const existing = toolCalls.find((t) => t.id === delta.tool!.id);
              if (existing) existing.status = delta.tool.status;
              else toolCalls.push({ ...delta.tool });
              callbacks.onTool?.(delta.tool);
            }
            // 图表产物：直接下发给前端渲染，同时留一份落库
            if (delta.charts && delta.charts.length) {
              charts.push(...delta.charts);
              callbacks.onCharts?.(delta.charts);
            }
            // 流程图产物：同上，前端拿到结构后自己布局
            if (delta.flowcharts && delta.flowcharts.length) {
              flowcharts.push(...delta.flowcharts);
              callbacks.onFlowcharts?.(delta.flowcharts);
            }
          },
        },
      );

      if (
        conversationId &&
        (fullText ||
          images.length ||
          toolCalls.length ||
          charts.length ||
          flowcharts.length)
      ) {
        await this.saveMessage(
          conversationId,
          'assistant',
          fullText,
          images,
          modelType,
          undefined,
          toolCalls,
          charts,
          flowcharts,
        );
      }
      // 会话结束：记录当前时间到 updatedAt
      if (conversationId) await this.touchConversation(conversationId);
      // 记忆刷新是事后增强，不阻塞本次响应结束（内部已吞掉异常）
      if (conversationId) void this.memoryService.refresh(conversationId);

      callbacks.onDone();
    } catch (e) {
      // 即使异常也尝试保存已有的结果
      if (
        conversationId &&
        (fullText ||
          images.length ||
          toolCalls.length ||
          charts.length ||
          flowcharts.length)
      ) {
        await this.saveMessage(
          conversationId,
          'assistant',
          fullText,
          images,
          modelType,
          undefined,
          toolCalls,
          charts,
          flowcharts,
        );
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
}
