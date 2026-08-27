/**
 * 流程图产物类型：模型只输出「有哪些节点、怎么连」，
 * 布局（dagre）与配色全部由前端 G6 完成，服务端不算坐标。
 *
 * 与图表一致，产物经 SSE 的 flowcharts 通道直接下发给前端渲染，
 * 不回灌模型上下文（避免模型再用 ASCII/Mermaid 复述一遍）。
 */

/** 节点语义，决定前端画成什么形状：start/end=胶囊，process=矩形，decision=菱形，io=平行四边形 */
export const FLOW_NODE_TYPES = [
  'start',
  'end',
  'process',
  'decision',
  'io',
] as const;

export type FlowNodeType = (typeof FLOW_NODE_TYPES)[number];

/** 流程方向：TB=自上而下，LR=从左到右 */
export const FLOW_DIRECTIONS = ['TB', 'LR'] as const;

export type FlowDirection = (typeof FLOW_DIRECTIONS)[number];

export interface FlowchartNode {
  /** 节点唯一 id，边通过它引用节点 */
  id: string;
  /** 节点显示文案 */
  label: string;
  /** 归一化后的节点语义，缺省为 process */
  type: FlowNodeType;
  /** 补充说明，前端 hover 时展示 */
  description?: string;
}

export interface FlowchartEdge {
  source: string;
  target: string;
  /** 连线文案，判断分支的「是 / 否」写在这里 */
  label?: string;
}

/** 下发给前端的一张流程图 */
export interface FlowchartArtifact {
  /** 前端 key，服务端生成 */
  id: string;
  title: string;
  direction: FlowDirection;
  nodes: FlowchartNode[];
  edges: FlowchartEdge[];
}

/** 模型侧给的原始参数（未校验） */
export interface FlowchartSpec {
  title?: unknown;
  direction?: unknown;
  nodes?: unknown;
  edges?: unknown;
}

/** 规模上限：超出的部分直接截断，避免一屏塞不下或渲染卡顿 */
export const FLOW_LIMITS = {
  maxNodes: 60,
  maxEdges: 120,
  maxLabel: 60,
  maxDescription: 200,
} as const;
