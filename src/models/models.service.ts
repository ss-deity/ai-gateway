import { Injectable } from '@nestjs/common';
import {
  DEFAULT_MODEL_TYPE,
  type ModelProvider,
} from './model.types.js';
import { DeepseekProvider } from './providers/deepseek.provider.js';
import { JimengProvider } from './providers/jimeng.provider.js';

/**
 * 模型注册表 / 中间层：按 type 选中对应 Provider。
 * 扩展新模型：实现 ModelProvider 后在构造函数中 register 即可。
 */
@Injectable()
export class ModelsService {
  private readonly providers = new Map<string, ModelProvider>();

  constructor(deepseek: DeepseekProvider, jimeng: JimengProvider) {
    this.register(deepseek);
    this.register(jimeng);
  }

  register(provider: ModelProvider): void {
    this.providers.set(provider.type, provider);
  }

  /** 支持的模型 type 列表 */
  listTypes(): string[] {
    return [...this.providers.keys()];
  }

  /** 按 type 获取 Provider；未知 type 回退到默认模型 */
  getProvider(type?: string): ModelProvider {
    return (
      (type && this.providers.get(type)) ||
      this.providers.get(DEFAULT_MODEL_TYPE)!
    );
  }
}
