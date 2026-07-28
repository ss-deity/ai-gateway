import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
} from 'typeorm';
import { Conversation } from './conversation.entity.js';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn()
  id!: number;

  /**
   * 业务 UID：注册时生成的 UUID，稳定不变；用作 BOS 用户存储目录名及跨服务的用户标识。
   */
  @Column({ length: 64, unique: true, nullable: true })
  uid!: string;

  @Column({ length: 100, unique: true })
  username!: string;

  @Column({ length: 100, nullable: true })
  nickname!: string;

  @Column({ length: 255 })
  password!: string;

  @Column({ length: 255, nullable: true })
  email!: string;

  @Column({ length: 500, nullable: true })
  avatar!: string;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @OneToMany(() => Conversation, (conversation) => conversation.user)
  conversations!: Conversation[];
}
