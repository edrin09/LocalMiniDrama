import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateDramaDto, UpdateDramaDto } from './dto/drama.dto';
import * as fs from 'fs';
import * as path from 'path';

const uploadRoot = () =>
  process.env.UPLOAD_DIR ? path.resolve(process.cwd(), process.env.UPLOAD_DIR) : null;

@Injectable()
export class DramaService {
  constructor(private readonly prisma: PrismaService) {}

  private readonly select = {
    id: true,
    title: true,
    description: true,
    dialect: true,
    coverStyle: true,
    seed: true,
    createdAt: true,
    updatedAt: true,
    _count: { select: { episodes: true, characters: true } },
  };

  // 项目列表：含分集数 / 角色数 / 更新时间 / 合并状态；排除软删除
  async findAll() {
    const rows = await this.prisma.drama.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: 'desc' },
      select: {
        ...this.select,
        episodes: {
          where: { deletedAt: null },
          select: { id: true, merged: true, status: true },
        },
      },
    });
    return rows.map((d) => ({
      ...d,
      episodeCount: d._count.episodes,
      characterCount: d._count.characters,
      mergedCount: d.episodes.filter((e) => e.merged).length,
      // 进度状态：无分集->未开始；有已合并->已完成；否则编辑中
      progress:
        d._count.episodes === 0
          ? 'not_started'
          : d.episodes.some((e) => e.merged)
            ? 'completed'
            : 'editing',
      // 剥离内部字段
      episodes: undefined,
    }));
  }

  async findOne(id: number) {
    const drama = await this.prisma.drama.findFirst({
      where: { id, deletedAt: null },
      include: {
        characters: { where: { deletedAt: null } },
        episodes: { where: { deletedAt: null } },
      },
    });
    if (!drama) throw new NotFoundException(`项目 ${id} 不存在`);
    return drama;
  }

  async create(dto: CreateDramaDto) {
    const data: any = {
      title: dto.title?.trim() || '未命名项目',
      description: dto.description ?? null,
      dialect: dto.dialect ?? 'standard',
      coverStyle: dto.coverStyle ?? 'default',
      seed: dto.seed ?? this.randomSeed(),
    };
    // 大标题去空格用于物理目录名
    data.title = data.title;
    const drama = await this.prisma.drama.create({ data });
    await this.ensureUploadDir(drama);
    return drama;
  }

  async update(id: number, dto: UpdateDramaDto) {
    const exist = await this.prisma.drama.findFirst({
      where: { id, deletedAt: null },
    });
    if (!exist) throw new NotFoundException(`项目 ${id} 不存在`);

    const data: any = {};
    if (dto.title !== undefined) data.title = dto.title?.trim() || '未命名项目';
    if (dto.description !== undefined)
      data.description = dto.description ?? null;
    if (dto.dialect !== undefined) data.dialect = dto.dialect ?? 'standard';
    if (dto.coverStyle !== undefined) data.coverStyle = dto.coverStyle ?? null;
    if (dto.seed !== undefined) data.seed = dto.seed;

    return this.prisma.drama.update({ where: { id }, data });
  }

  // 软删除：移除分镜/场景/道具/角色（角色为整剧共享故一并软删）
  // 并物理删除以该剧 id 命名开头的素材目录（异步，避免阻塞事件循环）
  async remove(id: number) {
    const exist = await this.prisma.drama.findFirst({
      where: { id, deletedAt: null },
      include: { episodes: { where: { deletedAt: null } } },
    });
    if (!exist) throw new NotFoundException(`项目 ${id} 不存在`);

    const episodeIds = exist.episodes.map((e) => e.id);

    await this.prisma.$transaction(async (tx) => {
      if (episodeIds.length) {
        await tx.storyboard.updateMany({
          where: { episodeId: { in: episodeIds } },
          data: { deletedAt: new Date(), status: 'cancelled' },
        });
        await tx.prop.updateMany({
          where: { episodeId: { in: episodeIds } },
          data: { deletedAt: new Date() },
        });
        await tx.scene.updateMany({
          where: { episodeId: { in: episodeIds } },
          data: { deletedAt: new Date() },
        });
        await tx.episode.updateMany({
          where: { id: { in: episodeIds } },
          data: { deletedAt: new Date() },
        });
      }
      await tx.character.updateMany({
        where: { dramaId: id },
        data: { deletedAt: new Date() },
      });
      await tx.drama.update({
        where: { id },
        data: { deletedAt: new Date() },
      });
    });

    // 异步物理删除素材目录，不阻塞事件循环
    this.cleanupMaterials(id);

    return { id, deleted: true };
  }

  private async ensureUploadDir(drama: { id: number }) {
    const root = uploadRoot();
    if (!root) return;
    await fs.promises.mkdir(path.join(root, String(drama.id)), {
      recursive: true,
    });
  }

  private cleanupMaterials(id: number) {
    const root = uploadRoot();
    if (!root) return;
    const target = path.join(root, String(id));
    fs.promises
      .rm(target, { recursive: true, force: true })
      .catch((e) => console.warn(`[DramaService] 素材目录删除失败: ${e.message}`));
  }

  private randomSeed() {
    return Math.floor(Math.random() * 1_000_000);
  }
}