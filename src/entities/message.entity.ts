import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
} from 'typeorm';
import { Conversation } from './conversation.entity.js';
import type { ChartArtifact } from '../charts/chart.types.js';
import type { FlowchartArtifact } from '../flowcharts/flowchart.types.js';

@Entity('messages')
export class Message {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'enum', enum: ['user', 'assistant'] })
  role!: 'user' | 'assistant';

  @Column({ type: 'text' })
  content!: string;

  /** 生成的图片 URL 列表（如即梦图片生成），文本消息为空 */
  @Column({ type: 'simple-json', nullable: true })
  images?: string[];

  /** 用户上传的附件列表（图片 / 文档），仅 user 消息使用 */
  @Column({ type: 'simple-json', nullable: true })
  attachments?: { url: string; name: string; type: string; size: number }[];

  /** 生成该消息所用的模型 type（如 deepseek-v4 / jimeng-v4.6） */
  @Column({ type: 'varchar', length: 64, nullable: true })
  model?: string;

  /** 本条回复过程中发生的工具调用（含最终状态），用于历史回显 */
  @Column({ type: 'simple-json', nullable: true })
  toolCalls?: { id: string; name: string; status: 'running' | 'done' }[];

  /**
   * 本条回复产出的 ECharts 图表（如 excel_to_echarts 的结果），用于历史回显。
   * option 完整存下来，刷新后不必重新解析 Excel。
   */
  @Column({ type: 'simple-json', nullable: true })
  charts?: ChartArtifact[];

  /**
   * 本条回复产出的流程图（generate_flowchart 的结果），用于历史回显。
   * 只存节点与连线，坐标由前端 G6 每次重新布局。
   */
  @Column({ type: 'simple-json', nullable: true })
  flowcharts?: FlowchartArtifact[];

  @ManyToOne(() => Conversation, (conversation) => conversation.messages)
  conversation!: Conversation;

  @Column()
  conversationId!: number;

  @CreateDateColumn()
  createdAt!: Date;
}
