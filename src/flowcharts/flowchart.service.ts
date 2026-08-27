import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  FLOW_DIRECTIONS,
  FLOW_LIMITS,
  FLOW_NODE_TYPES,
  type FlowDirection,
  type FlowNodeType,
  type FlowchartArtifact,
  type FlowchartEdge,
  type FlowchartNode,
  type FlowchartSpec,
} from './flowchart.types.js';

/** 归一化结果：要么拿到一份可渲染的产物，要么拿到一句给模型看的错误说明 */
export type FlowchartResult =
  | { ok: true; artifact: FlowchartArtifact; warnings: string[] }
  | { ok: false; error: string };

/**
 * 流程图规整服务：把模型给的松散 JSON 收敛成一份确定可渲染的图。
 *
 * 模型经常会犯这几类错：节点 id 重复、边指向不存在的节点、把「是/否」写进节点名、
 * 只给节点不给边。这里全部就地修掉或截断，只有「压根没有有效节点/边」才退回给模型重试，
 * 避免一点小瑕疵就多花一次模型往返。
 */
@Injectable()
export class FlowchartService {
  private readonly logger = new Logger(FlowchartService.name);

  build(spec: FlowchartSpec): FlowchartResult {
    const warnings: string[] = [];

    const rawNodes = Array.isArray(spec.nodes) ? spec.nodes : [];
    const rawEdges = Array.isArray(spec.edges) ? spec.edges : [];
    if (rawNodes.length < 2) {
      return { ok: false, error: 'nodes 至少要有 2 个节点，请补齐后重新调用' };
    }

    // 1) 节点：去重 id、补默认类型、截断超长文案
    const nodes: FlowchartNode[] = [];
    const seen = new Set<string>();
    for (const item of rawNodes) {
      if (!item || typeof item !== 'object') continue;
      const raw = item as Record<string, unknown>;
      const id = text(raw.id) || text(raw.key);
      const label = text(raw.label) || text(raw.text) || text(raw.name) || id;
      if (!id || !label) continue;
      if (seen.has(id)) {
        warnings.push(`节点 id 重复已忽略：${id}`);
        continue;
      }
      if (nodes.length >= FLOW_LIMITS.maxNodes) {
        warnings.push(`节点数超过 ${FLOW_LIMITS.maxNodes} 个，已截断`);
        break;
      }
      seen.add(id);
      const description = text(raw.description) || text(raw.desc);
      nodes.push({
        id,
        label: clip(label, FLOW_LIMITS.maxLabel),
        type: nodeType(raw.type),
        description: description
          ? clip(description, FLOW_LIMITS.maxDescription)
          : undefined,
      });
    }
    if (nodes.length < 2) {
      return {
        ok: false,
        error: 'nodes 里可用的节点少于 2 个（每个节点需要 id 和 label）',
      };
    }

    // 2) 边：丢掉自环与悬空端点，同一对节点上的同名连线只保留一条
    const edges: FlowchartEdge[] = [];
    const edgeKeys = new Set<string>();
    for (const item of rawEdges) {
      if (!item || typeof item !== 'object') continue;
      const raw = item as Record<string, unknown>;
      const source = text(raw.source) || text(raw.from);
      const target = text(raw.target) || text(raw.to);
      if (!source || !target) continue;
      if (!seen.has(source) || !seen.has(target)) {
        warnings.push(`连线端点不存在已忽略：${source} -> ${target}`);
        continue;
      }
      if (source === target) {
        warnings.push(`自环连线已忽略：${source}`);
        continue;
      }
      const label = text(raw.label) || text(raw.text);
      const key = `${source}->${target}:${label}`;
      if (edgeKeys.has(key)) continue;
      if (edges.length >= FLOW_LIMITS.maxEdges) {
        warnings.push(`连线数超过 ${FLOW_LIMITS.maxEdges} 条，已截断`);
        break;
      }
      edgeKeys.add(key);
      edges.push({
        source,
        target,
        label: label ? clip(label, FLOW_LIMITS.maxLabel) : undefined,
      });
    }
    if (!edges.length) {
      return {
        ok: false,
        error:
          'edges 里没有有效连线，source/target 必须是 nodes 中已存在的节点 id',
      };
    }

    // 3) 孤立节点：不影响渲染（dagre 会单独摆一列），只记一条提示
    const linked = new Set<string>();
    for (const e of edges) {
      linked.add(e.source);
      linked.add(e.target);
    }
    const isolated = nodes.filter((n) => !linked.has(n.id));
    if (isolated.length) {
      warnings.push(
        `以下节点没有任何连线：${isolated.map((n) => n.label).join('、')}`,
      );
    }

    if (warnings.length) {
      this.logger.warn(`流程图已修正：${warnings.join('；')}`);
    }

    return {
      ok: true,
      warnings,
      artifact: {
        id: `flow_${randomUUID()}`,
        title: clip(text(spec.title) || '流程图', FLOW_LIMITS.maxLabel),
        direction: direction(spec.direction),
        nodes,
        edges,
      },
    };
  }
}

function text(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  return '';
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function nodeType(value: unknown): FlowNodeType {
  const raw = text(value).toLowerCase();
  if ((FLOW_NODE_TYPES as readonly string[]).includes(raw)) {
    return raw as FlowNodeType;
  }
  // 模型常用的近义写法归一到标准类型，避免因为一个词就退回重试
  if (raw === 'begin' || raw === 'startevent') return 'start';
  if (raw === 'stop' || raw === 'finish' || raw === 'terminator') return 'end';
  if (raw === 'condition' || raw === 'judge' || raw === 'branch') {
    return 'decision';
  }
  if (raw === 'input' || raw === 'output' || raw === 'data') return 'io';
  return 'process';
}

function direction(value: unknown): FlowDirection {
  const raw = text(value).toUpperCase();
  return (FLOW_DIRECTIONS as readonly string[]).includes(raw)
    ? (raw as FlowDirection)
    : 'TB';
}
