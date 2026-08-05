import { Controller, Get, Post, Body, Res, Param, Query, Delete, Put } from '@nestjs/common';
import type { Response } from 'express';
import { AppService } from './app.service';
import type { Attachment } from './models/model.types.js';

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
        onImages(images: string[]) {
          res.write(
            `data: ${JSON.stringify({ choices: [{ delta: { images } }], sessionId, conversationId })}\n\n`,
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
      body.model,
      body.thinking,
      body.attachments,
      body.skills,
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
