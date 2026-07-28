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

  @Column({ length: 100, unique: true })
  username!: string;

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
