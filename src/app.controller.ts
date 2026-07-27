import { Controller, Get, Post, Body, Res, Param, Query } from '@nestjs/common';
import type { Response } from 'express';
import { AppService } from './app.service';

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
          username: result.username,
          avatar: '',
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
          username: user.username,
          avatar: '',
        },
      },
    };
  }

  /**
   * SSE 流式对话
   */
  @Post('chat')
  async chat(
    @Body() body: { message: string; conversationId?: number; userId?: number },
    @Res() res: Response,
  ) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const sessionId = this.appService.createSession();

    let conversationId = body.conversationId;
    if (!conversationId) {
      const userId = body.userId;
      let user;
      if (userId) {
        user = await this.appService.getUserById(userId);
      }
      if (!user) {
        user = await this.appService.getDefaultUser();
      }
      const conversation = await this.appService.createConversation(
        user.id,
        body.message.slice(0, 50),
      );
      conversationId = conversation.id;
    }

    res.on('close', () => {
      this.appService.cancelSession(sessionId);
    });

    await this.appService.chatStream(
      sessionId,
      body.message,
      {
        onToken(token: string) {
          res.write(
            `data: ${JSON.stringify({ choices: [{ delta: { content: token } }], sessionId, conversationId })}\n\n`,
          );
        },
        onDone() {
          res.write('data: [DONE]\n\n');
          res.end();
        },
        onError(error: Error) {
          res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
          res.end();
        },
      },
      conversationId,
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
