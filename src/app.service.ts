import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';

@Injectable()
export class AppService {
  private readonly client = new OpenAI({
    apiKey: 'sk-664a40277262463cabca0f9aa2c6a2d8',
    baseURL: 'https://api.deepseek.com',
  });

  getHello(): string {
    return 'Hello World!';
  }

  async chat(message: string): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: message }],
    });

    return response.choices[0].message.content ?? '';
  }
}
