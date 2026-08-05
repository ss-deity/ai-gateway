import { Controller, Get } from '@nestjs/common';
import { SkillsService } from './skills.service.js';

@Controller('skills')
export class SkillsController {
  constructor(private readonly skillsService: SkillsService) {}

  /**
   * 技能列表（输入框 `/` 面板的数据源）
   * GET /skills
   * prompt 只在服务端使用，不下发给前端。
   */
  @Get()
  list() {
    const data = this.skillsService.list().map((s) => ({
      id: s.id,
      command: s.command,
      name: s.name,
      description: s.description,
      category: s.category,
    }));
    return { code: 0, message: 'success', data };
  }
}
