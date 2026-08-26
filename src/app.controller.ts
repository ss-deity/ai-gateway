import { Controller, Get, Post, Body, Res, Param, Query, Delete, Put } from '@nestjs/common';
import type { Response } from 'express';
import { AppService } from './app.service';
import type { Attachment } from './models/model.types.js';

/** SSE 心跳间隔：长时间没有增量时保持连接活着 */
const HEARTBEAT_INTERVAL_MS = 15_000;

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Get('test')
  test(): string {
    return '你好';
  }

  /**
   * 注册接口
   * POST /auth/register
   */
  @Post('auth/register')
  async register(@Body() body: { username: string; password: string }) {
    const { username, password } = body;
    if (!username || !password) {
      return { code: -1, message: '账号和密码不能为空', data: null };
    }

    const result = await this.appService.register(username, password);
    if (!result) {
      return { code: -1, message: '用户名已存在', data: null };
    }

    const token = this.appService.generateToken(result);

    return {
      code: 0,
      message: 'success',
      data: {
        token,
        user: {
          id: String(result.id),
          uid: result.uid,
          username: result.username,
          nickname: result.nickname || result.username,
          avatar: result.avatar || '',
        },
      },
    };
  }

  /**
   * 登录接口
   * POST /auth/login
   */
  @Post('auth/login')
  async login(@Body() body: { username: string; password: string }) {
    const { username, password } = body;
    if (!username || !password) {
      return { code: -1, message: '账号和密码不能为空', data: null };
    }

    const user = await this.appService.login(username, password);
    if (!user) {
      return { code: -1, message: '账号或密码错误', data: null };
    }

    const token = this.appService.generateToken(user);

    return {
      code: 0,
      message: 'success',
      data: {
        token,
        user: {
          id: String(user.id),
          uid: user.uid,
          username: user.username,
          nickname: user.nickname || user.username,
          avatar: user.avatar || '',
        },
      },
    };
  }

  /**
   * 退出登录接口
   * POST /auth/logout
   */
  @Post('auth/logout')
  async logout() {
    return { code: 0, message: '退出成功', data: null };
  }

  /**
   * 获取用户信息
   * GET /users/:id
   */
  @Get('users/:id')
  async getUser(@Param('id') id: string) {
    const user = await this.appService.getUserById(Number(id));
    if (!user) {
      return { code: -1, message: '用户不存在', data: null };
    }
    return {
      code: 0,
      message: 'success',
      data: {
        id: String(user.id),
        uid: user.uid,
        username: user.username,
        nickname: user.nickname || user.username,
        avatar: user.avatar || '',
      },
    };
  }

  /**
   * 更新用户信息（仅名称 nickname 和头像 avatar）
   * PUT /users/:id
   * 说明：登录账号 username 不允许通过此接口修改。
   */
  @Put('users/:id')
  async updateUser(
    @Param('id') id: string,
    @Body() body: { nickname?: string; avatar?: string },
  ) {
    const user = await this.appService.updateUser(Number(id), {
      nickname: body.nickname,
      avatar: body.avatar,
    });
    if (!user) {
      return { code: -1, message: '用户不存在', data: null };
    }
    return {
      code: 0,
      message: 'success',
      data: {
        id: String(user.id),
        uid: user.uid,
        username: user.username,
        nickname: user.nickname || user.username,
        avatar: user.avatar || '',
      },
    };
  }

  /**
   * SSE 流式对话
   */
  @Post('chat')
  async chat(
    @Body()
    body: {
      message: string;
      conversationId?: number;
      userId?: number;
      model?: string;
      thinking?: boolean;
      attachments?: Attachment[];
      /** 输入框 `/` 唤起的技能 id 列表（见 GET /skills） */
      skills?: string[];
    },
    @Res() res: Response,
  ) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    // 反向代理（nginx 等）默认会缓冲响应体，SSE 必须显式关掉，否则增量会被攒着一次性下发
    res.setHeader('X-Accel-Buffering', 'no');
    // 立刻把响应头发出去：不然浏览器要等到第一个 chunk 才认为请求开始，
    // 首个 token 之前的等待期（模型思考、工具参数生成）前端完全无感。
    res.flushHeaders();

    const sessionId = this.appService.createSession();

    // 工具产物（如 create_ppt 生成的 .pptx）要落到具体用户的文件目录，
    // 因此这里始终解析出一个有效用户，而不只是在新建会话时才解析。
    let user = body.userId
      ? await this.appService.getUserById(body.userId)
      : null;
    if (!user) {
      user = await this.appService.getDefaultUser();
    }

    let conversationId = body.conversationId;
    if (!conversationId) {
      const conversation = await this.appService.createConversation(
        user.id,
        body.message.slice(0, 50),
      );
      conversationId = conversation.id;
    }

    // 心跳：生成 PPT 这类长工具调用期间没有任何增量，
    // 定时发一行 SSE 注释保持连接活着（前端解析时会忽略非 data: 行）。
    const heartbeat = setInterval(() => {
      res.write(': ping\n\n');
    }, HEARTBEAT_INTERVAL_MS);

    res.on('close', () => {
      clearInterval(heartbeat);
      this.appService.cancelSession(sessionId);
    });

    // 先发一帧「只带 id」的事件：前端据此拿到 sessionId 与 conversationId，
    // 从而在首个 token 之前就能显示等待状态、也能随时暂停/终止本次生成。
    res.write(
      `data: ${JSON.stringify({ choices: [{ delta: {} }], sessionId, conversationId })}\n\n`,
    );

    await this.appService.chatStream(
      sessionId,
      body.message,
      {
        onToken(token: string) {
          res.write(
            `data: ${JSON.stringify({ choices: [{ delta: { content: token } }], sessionId, conversationId })}\n\n`,
          );
        },
        onImages(images: string[]) {
          res.write(
            `data: ${JSON.stringify({ choices: [{ delta: { images } }], sessionId, conversationId })}\n\n`,
          );
        },
        onTool(tool) {
          res.write(
            `data: ${JSON.stringify({ choices: [{ delta: { tool } }], sessionId, conversationId })}\n\n`,
          );
        },
        onDone() {
          clearInterval(heartbeat);
          res.write('data: [DONE]\n\n');
          res.end();
        },
        onError(error: Error) {
          clearInterval(heartbeat);
          // OpenAI SDK 的 APIError 带 status/code/type，透传给前端做归类
          // （余额不足 402 / 限流 429 / 鉴权 401 等文案不一致，靠状态码更稳）
          const api = error as Error & {
            status?: number;
            code?: string;
            type?: string;
          };
          res.write(
            `data: ${JSON.stringify({
              error: error.message || '模型服务返回错误',
              status: typeof api.status === 'number' ? api.status : undefined,
              code: typeof api.code === 'string' ? api.code : undefined,
              sessionId,
              conversationId,
            })}\n\n`,
          );
          res.end();
        },
      },
      conversationId,
      body.model,
      body.thinking,
      body.attachments,
      body.skills,
      user.id,
    );
  }

  /**
   * 获取会话列表
   */
  @Get('conversations')
  async getConversations(@Query('userId') userId?: string) {
    if (userId) {
      return this.appService.getConversations(Number(userId));
    }
    const user = await this.appService.getDefaultUser();
    return this.appService.getConversations(user.id);
  }

  /**
   * 获取会话消息历史
   */
  @Get('conversations/:id/messages')
  async getMessages(@Param('id') id: string) {
    return this.appService.getMessages(Number(id));
  }

  /**
   * 删除会话（连同其所有消息）
   */
  @Delete('conversations/:id')
  async deleteConversation(@Param('id') id: string) {
    const success = await this.appService.deleteConversation(Number(id));
    if (!success) {
      return { code: -1, message: '会话不存在', data: null };
    }
    return { code: 0, message: 'success', data: null };
  }

  /**
   * 重命名会话
   * PUT /conversations/:id  { title }
   */
  @Put('conversations/:id')
  async renameConversation(
    @Param('id') id: string,
    @Body() body: { title?: string },
  ) {
    if (!body?.title || !body.title.trim()) {
      return { code: -1, message: '标题不能为空', data: null };
    }
    const conv = await this.appService.updateConversationTitle(
      Number(id),
      body.title,
    );
    if (!conv) {
      return { code: -1, message: '会话不存在', data: null };
    }
    return {
      code: 0,
      message: 'success',
      data: { id: String(conv.id), title: conv.title },
    };
  }

  @Post('chat/pause/:sessionId')
  pauseChat(@Param('sessionId') sessionId: string) {
    const success = this.appService.pauseSession(sessionId);
    return { success };
  }

  @Post('chat/resume/:sessionId')
  resumeChat(@Param('sessionId') sessionId: string) {
    const success = this.appService.resumeSession(sessionId);
    return { success };
  }

  @Post('chat/cancel/:sessionId')
  cancelChat(@Param('sessionId') sessionId: string) {
    this.appService.cancelSession(sessionId);
    return { success: true };
  }
}
