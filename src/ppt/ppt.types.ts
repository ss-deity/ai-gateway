/** PPT 生成相关的数据结构：create_ppt 的入参形状与生成结果 */

/** PPT 视觉风格（与 create_ppt 工具的 theme 枚举一致） */
export type PptTheme =
  'business' | 'technology' | 'minimal' | 'education' | 'report';

export type PptLanguage = 'zh-CN' | 'en-US';

/**
 * 单页版式。auto 表示交给服务端按内容形态推断，
 * 其余为模型可以显式指定的版式，用来避免整份 PPT 从头到尾一个样子。
 */
export type PptSlideLayout =
  | 'auto'
  /** 编号要点列表（默认） */
  | 'bullets'
  /** 卡片网格：短要点并排展示 */
  | 'cards'
  /** 数据看板：几个关键数字 + 说明 */
  | 'metrics'
  /** 分栏对比：2-3 栏各自有小标题 */
  | 'comparison'
  /** 时间轴 / 步骤流程 */
  | 'timeline'
  /** 大字观点页 */
  | 'quote'
  /** 章节分隔页 */
  | 'section';

/** 关键数字（metrics 版式使用） */
export interface PptMetric {
  /** 数字本身，如 `38%`、`2.4 亿` */
  value: string;
  /** 数字含义 */
  label: string;
}

/** 分栏（comparison 版式使用） */
export interface PptColumn {
  title: string;
  bullets: string[];
}

/** 模型规划出的一页 PPT */
export interface PptSlideSpec {
  title: string;
  /** 正文：多行（每行一条要点）或一段话。bullets 缺省时由它拆出要点 */
  content: string;
  /** 副标题 / 本页导语，显示在标题下方 */
  subtitle?: string;
  /** 要点列表，优先于 content */
  bullets?: string[];
  /** 关键数字 */
  metrics?: PptMetric[];
  /** 分栏内容 */
  columns?: PptColumn[];
  /** 本页结论，渲染成底部结论条 */
  takeaway?: string;
  /** 讲者备注，写进 pptx 的备注栏 */
  notes?: string;
  /** 版式，缺省为 auto */
  layout?: PptSlideLayout;
}

/** 模型规划出的整份 PPT（create_ppt 的入参） */
export interface PptSpec {
  title: string;
  /** 封面副标题（汇报人 / 场景 / 日期等） */
  subtitle?: string;
  theme: PptTheme;
  language: PptLanguage;
  slideCount: number;
  slides: PptSlideSpec[];
}

export interface PptResult {
  fileName: string;
  /** 相对用户文件管理根目录的路径 */
  path: string;
  /** 可直接下载的 URL */
  downloadUrl: string;
  size: number;
  slideCount: number;
}
