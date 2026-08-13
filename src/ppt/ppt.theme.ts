import type { PptLanguage, PptTheme } from './ppt.types.js';

/** 一套主题的配色与字体 */
export interface ThemeStyle {
  /** 内容页背景 */
  bg: string;
  /** 内容页浅色块（卡片、结论条底色） */
  surface: string;
  /** 封面 / 章节页 / 结尾页背景 */
  deepBg: string;
  /** 深色背景上的文字色 */
  onDeep: string;
  /** 标题色 */
  title: string;
  /** 正文色 */
  text: string;
  /** 强调色（色条、编号、数字） */
  accent: string;
  /** 次要文字色（页脚、注释） */
  muted: string;
  /** 分隔线色 */
  line: string;
  /** 卡片 / 时间轴节点的轮换色，让同一页的多个元素有层次 */
  palette: string[];
}

export const THEMES: Record<PptTheme, ThemeStyle> = {
  business: {
    bg: 'FFFFFF',
    surface: 'F2F5FA',
    deepBg: '13294B',
    onDeep: 'FFFFFF',
    title: '13294B',
    text: '333F4F',
    accent: 'C8102E',
    muted: '8A94A6',
    line: 'DCE3ED',
    palette: ['13294B', 'C8102E', '2E5C8A', '6B7C93'],
  },
  technology: {
    bg: 'FFFFFF',
    surface: 'EEF6FF',
    deepBg: '0A1A2F',
    onDeep: 'FFFFFF',
    title: '0A1A2F',
    text: '2E3A4B',
    accent: '0A84FF',
    muted: '8A94A6',
    line: 'D7E6F5',
    palette: ['0A84FF', '00C2A8', '5E5CE6', '0A1A2F'],
  },
  minimal: {
    bg: 'FFFFFF',
    surface: 'F5F5F5',
    deepBg: '1C1C1E',
    onDeep: 'FFFFFF',
    title: '1C1C1E',
    text: '3F3F46',
    accent: '1C1C1E',
    muted: 'A1A1AA',
    line: 'E4E4E7',
    palette: ['1C1C1E', '52525B', '8E8E93', 'C7C7CC'],
  },
  education: {
    bg: 'FFFFFF',
    surface: 'F1F8F2',
    deepBg: '1B5E20',
    onDeep: 'FFFFFF',
    title: '1B5E20',
    text: '374151',
    accent: 'F59E0B',
    muted: '9CA3AF',
    line: 'DCEBDD',
    palette: ['2E7D32', 'F59E0B', '0288D1', '8D6E63'],
  },
  report: {
    bg: 'FFFFFF',
    surface: 'F0F4F5',
    deepBg: '22333B',
    onDeep: 'FFFFFF',
    title: '22333B',
    text: '37474F',
    accent: '00838F',
    muted: '90A4AE',
    line: 'DCE5E7',
    palette: ['00838F', '546E7A', 'EF6C00', '283593'],
  },
};

/** 中文用雅黑，英文用 Arial（都是各平台自带字体，避免打开后字体缺失） */
export function fontOf(language: PptLanguage): string {
  return language === 'en-US' ? 'Arial' : 'Microsoft YaHei';
}

/** 主题色轮换：同一页里第 n 个元素用哪个色 */
export function paletteAt(theme: ThemeStyle, index: number): string {
  return theme.palette[index % theme.palette.length];
}
