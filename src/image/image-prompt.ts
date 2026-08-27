/**
 * 即梦请求构造：把「一句需求」整理成即梦更吃得住的 prompt 与提交参数。
 *
 * 即梦对「主体 + 场景 + 构图 + 风格 + 光线 + 画质」这类描述性中文提示效果最好，
 * 对「帮我生成一张…」这类对话式指令则容易把指令词本身画进画面，因此这里统一：
 *   1. 去掉开头的指令性措辞（生成/画一张…）
 *   2. 按目标比例给出即梦官方推荐分辨率（约 150 万像素，画质最稳）
 *   3. 提示过短时交给即梦自带的 prompt 扩写（use_pre_llm），足够详细时关掉，避免改写掉细节
 */

export const IMAGE_ASPECT_RATIOS = [
  '1:1',
  '4:3',
  '3:4',
  '16:9',
  '9:16',
  '3:2',
  '2:3',
] as const;

export type ImageAspectRatio = (typeof IMAGE_ASPECT_RATIOS)[number];

/** 即梦官方推荐尺寸（约 150 万像素）：偏离推荐值画质和构图都会变差 */
const SIZE_BY_RATIO: Record<
  ImageAspectRatio,
  { width: number; height: number }
> = {
  '1:1': { width: 1328, height: 1328 },
  '4:3': { width: 1472, height: 1104 },
  '3:4': { width: 1104, height: 1472 },
  '16:9': { width: 1664, height: 936 },
  '9:16': { width: 936, height: 1664 },
  '3:2': { width: 1584, height: 1056 },
  '2:3': { width: 1056, height: 1584 },
};

/** 客套前缀：请 / 帮我 / 我想… */
const POLITE_PREFIX =
  /^(?:请|麻烦|帮我|给我|能不能|可以|你能|我想|想要|需要)+\s*/;

/**
 * 创作动词前缀，两种形态：
 *   A「生成一张(图片)：」——动词后必须跟数量词，避免把「画中画效果」这类词误伤
 *   B「生成图片：」——动词后直接跟通用名词
 * 只吃「图片/图像」这类通用词；logo、海报、插画、照片本身是画面信息，保留在 prompt 里。
 */
const CREATE_WITH_QUANTIFIER =
  /^(?:生成|画|绘制|做|设计|创作|出)\s*(?:一|1)\s*(?:张|幅|个|副|只|条|组|套|份)?\s*(?:图片|图像)?\s*[:：,，]?\s*/;
const CREATE_WITH_NOUN =
  /^(?:生成|画|绘制|做|设计|创作|出)\s*(?:图片|图像)\s*[:：,，]?\s*/;

/** 低于该字数视为「一句话需求」，交给即梦自带扩写补全画面细节 */
const SHORT_PROMPT_CHARS = 24;

export interface JimengRequestInput {
  /** 画面描述（或改图指令） */
  prompt: string;
  /** 目标画面比例，省略按 1:1 */
  aspectRatio?: string;
  /** 参考图公网地址，非空即走图生图 */
  referenceImages?: string[];
}

export interface JimengRequest {
  prompt: string;
  params: Record<string, unknown>;
}

/** 兜底成合法比例，模型偶尔会传 "1920x1080" 这类值 */
export function normalizeAspectRatio(value?: string): ImageAspectRatio {
  return (IMAGE_ASPECT_RATIOS as readonly string[]).includes(value ?? '')
    ? (value as ImageAspectRatio)
    : '1:1';
}

export function buildJimengRequest(input: JimengRequestInput): JimengRequest {
  const aspectRatio = normalizeAspectRatio(input.aspectRatio);
  const referenceImages = (input.referenceImages ?? []).filter(Boolean);
  const prompt = normalizePrompt(input.prompt);

  const params: Record<string, unknown> = {
    ...SIZE_BY_RATIO[aspectRatio],
    // 详细提示自己就够了，再让上游 LLM 扩写反而会冲掉指定的细节
    use_pre_llm: prompt.length < SHORT_PROMPT_CHARS,
  };
  if (referenceImages.length) params.image_urls = referenceImages;

  return { prompt, params };
}

/** 去掉对话式指令前缀并压掉多余空白；剥完为空时退回原文 */
function normalizePrompt(raw: string): string {
  const text = (raw || '').replace(/\s+/g, ' ').trim();
  const withoutPolite = text.replace(POLITE_PREFIX, '');
  const stripped = CREATE_WITH_QUANTIFIER.test(withoutPolite)
    ? withoutPolite.replace(CREATE_WITH_QUANTIFIER, '')
    : withoutPolite.replace(CREATE_WITH_NOUN, '');
  return stripped.trim() || text;
}
