import { Injectable, Logger } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';

/** 一个技能的定义（对应 skills.json 中的一项） */
export interface Skill {
  /** 唯一标识，前端提交时回传 */
  id: string;
  /** 输入框 `/` 唤起时的指令名（英文，无空格） */
  command: string;
  /** 展示名称 */
  name: string;
  /** 一句话说明，展示在候选列表里 */
  description: string;
  /** 分组：system=系统技能，own=我的技能 */
  category: 'system' | 'own';
  /** 技能的执行要求，会拼进 system prompt 交给模型 */
  prompt: string;
}

interface SkillsFile {
  version: number;
  skills: Skill[];
}

/**
 * 技能定义的读取与 system prompt 拼装。
 *
 * 当前数据源是 `src/skills/skills.json`（后续换成数据库时，只要保持
 * `list()` / `resolve()` 的返回结构不变，上层无需改动）。
 * 编译产物中 json 由 nest-cli 的 assets 配置拷贝到 dist，
 * 这里按「dist 同目录 → 源码目录」的顺序找，兼容 build 与 ts 直跑两种方式。
 */
@Injectable()
export class SkillsService {
  private readonly logger = new Logger(SkillsService.name);

  private readonly skills: Skill[] = this.load();

  private load(): Skill[] {
    const candidates = [
      join(__dirname, 'skills.json'),
      join(process.cwd(), 'src', 'skills', 'skills.json'),
    ];
    for (const file of candidates) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf-8')) as SkillsFile;
        if (Array.isArray(parsed?.skills)) return parsed.skills;
      } catch {
        // 换下一个候选路径
      }
    }
    this.logger.warn(`未找到 skills.json（已尝试：${candidates.join(', ')}）`);
    return [];
  }

  /** 全量技能列表，供前端 `/` 面板渲染 */
  list(): Skill[] {
    return this.skills;
  }

  /** 按 id 或 command 查找（前端只回传 id，command 作为兜底） */
  find(idOrCommand: string): Skill | undefined {
    return this.skills.find(
      (s) => s.id === idOrCommand || s.command === idOrCommand,
    );
  }

  /** 过滤出有效技能，忽略未知 id 并去重 */
  resolve(ids?: string[]): Skill[] {
    if (!ids?.length) return [];
    const seen = new Set<string>();
    const result: Skill[] = [];
    for (const id of ids) {
      const skill = this.find(id);
      if (skill && !seen.has(skill.id)) {
        seen.add(skill.id);
        result.push(skill);
      }
    }
    return result;
  }

  /**
   * 把技能翻译成模型能理解的 system prompt。
   * 用户消息里的 `/command` 只是唤起标记，这里显式告知模型不要把它当内容。
   */
  buildSystemPrompt(ids?: string[]): string | undefined {
    const skills = this.resolve(ids);
    if (!skills.length) return undefined;

    const blocks = skills.map((s, i) =>
      [
        `技能 ${i + 1}：${s.name}（唤起指令：/${s.command}）`,
        `用途：${s.description}`,
        `执行要求：${s.prompt}`,
      ].join('\n'),
    );

    return [
      '用户为本次对话指定了以下技能，你必须严格按技能的执行要求作答。',
      '',
      blocks.join('\n\n'),
      '',
      '补充约定：',
      '1. 用户消息中形如 /' +
        skills.map((s) => s.command).join('、/') +
        ' 的片段只是技能唤起标记，不属于要处理的内容，忽略它。',
      '2. 多个技能同时生效时，按上面的顺序依次应用。',
      '3. 不要解释你被赋予了什么技能，直接给出符合要求的结果。',
    ].join('\n');
  }
}
