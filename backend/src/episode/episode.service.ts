import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateEpisodeDto, UpdateEpisodeDto } from './dto/episode.dto';
import * as fs from 'fs';
import * as path from 'path';

const uploadRoot = () =>
  process.env.UPLOAD_DIR ? path.resolve(process.cwd(), process.env.UPLOAD_DIR) : null;

const episodeSelect = {
  id: true,
  dramaId: true,
  title: true,
  episodeNumber: true,
  description: true,
  duration: true,
  status: true,
  merged: true,
  createdAt: true,
  updatedAt: true,
};

@Injectable()
export class EpisodeService {
  constructor(private readonly prisma: PrismaService) {}

  // 分集列表：含分镜数 / 预估时长（分镜 duration 求和）/ 状态；排除软删除
  async findAll(dramaId?: number) {
    const rows = await this.prisma.episode.findMany({
      where: { deletedAt: null, ...(dramaId ? { dramaId } : {}) },
      orderBy: { episodeNumber: 'asc' },
      select: {
        ...episodeSelect,
        scriptText: true,
        _count: { select: { storyboards: { where: { deletedAt: null } } } },
        storyboards: {
          where: { deletedAt: null },
          select: { duration: true },
        },
      },
    });
    return rows.map((e) => {
      const duration = e.storyboards.reduce((sum, s) => sum + (s.duration || 0), 0);
      return {
        id: e.id,
        dramaId: e.dramaId,
        title: e.title,
        episodeNumber: e.episodeNumber,
        description: e.description,
        duration: Number(duration.toFixed(1)),
        storyboardCount: e._count.storyboards,
        hasScript: !!(e.scriptText || '').trim(),
        status: e.status,
        merged: e.merged,
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
      };
    });
  }

  async findOne(id: number) {
    const episode = await this.prisma.episode.findFirst({
      where: { id, deletedAt: null },
      include: {
        storyboards: {
          where: { deletedAt: null },
          orderBy: { number: 'asc' },
        },
        scenes: { where: { deletedAt: null } },
        props: { where: { deletedAt: null } },
      },
    });
    if (!episode) throw new NotFoundException(`分集 ${id} 不存在`);
    return episode;
  }

  async create(dto: CreateEpisodeDto) {
    const drama = await this.prisma.drama.findFirst({
      where: { id: dto.dramaId, deletedAt: null },
    });
    if (!drama) throw new NotFoundException(`项目 ${dto.dramaId} 不存在`);

    // 取当前最大集编号 +1，作为新集的集编号与默认标题
    const max = await this.prisma.episode.aggregate({
      where: { dramaId: dto.dramaId, deletedAt: null },
      _max: { episodeNumber: true },
    });
    const episodeNumber = dto.episodeNumber ?? (max._max.episodeNumber ?? 0) + 1;
    const title =
      dto.title?.trim() || `第${episodeNumber}集：新分集`;

    const episode = await this.prisma.episode.create({
      data: {
        dramaId: dto.dramaId,
        title,
        description: dto.description ?? null,
        episodeNumber,
        status: 'draft',
        merged: false,
      },
    });
    await this.ensureUploadDir(drama.id, episode.id);
    return episode;
  }

  async update(id: number, dto: UpdateEpisodeDto) {
    const exist = await this.prisma.episode.findFirst({
      where: { id, deletedAt: null },
    });
    if (!exist) throw new NotFoundException(`分集 ${id} 不存在`);

    const data: any = {};
    if (dto.title !== undefined) data.title = dto.title?.trim() || '未命名分集';
    if (dto.description !== undefined) data.description = dto.description ?? null;
    if (dto.episodeNumber !== undefined) data.episodeNumber = dto.episodeNumber;
    if (dto.duration !== undefined) data.duration = dto.duration;
    if (dto.status !== undefined) data.status = dto.status;
    if (dto.merged !== undefined) data.merged = dto.merged;
    if (dto.mergeCfg !== undefined) data.mergeCfg = dto.mergeCfg;
    if (dto.genCfg !== undefined) data.genCfg = dto.genCfg;
    if (dto.scriptText !== undefined) data.scriptText = dto.scriptText ?? null;

    return this.prisma.episode.update({ where: { id }, data });
  }

  /**
   * 一键导入整本剧本：把整份 TXT 按「第N集」标题行拆分为多个分集，
   * 每个分集 = 标题（含集号）+ 该集剧本原文（scriptText），一次性批量落库。
   * 支持两种标题格式：
   *   - `第1集 初见兵马俑` / `第1集：初见兵马俑`
   *   - 或仅标题行（无「第N集」前缀时按顺序编号）
   */
  async importScript(
    dramaId: number,
    opts: { text?: string; mode?: 'append' | 'replace' } = {},
  ) {
    const drama = await this.prisma.drama.findFirst({
      where: { id: dramaId, deletedAt: null },
    });
    if (!drama) throw new NotFoundException(`项目 ${dramaId} 不存在`);

    const raw = (opts.text || '').replace(/\r\n/g, '\n').trim();
    if (!raw) throw new BadRequestException('导入文本为空，请先粘贴或上传剧本');

    // 按「第N集」标题行拆分
    const blocks = this.splitScriptByEpisode(raw);
    if (blocks.length === 0) {
      throw new BadRequestException('未能识别出任何分集，请确认剧本包含「第N集」标题行');
    }

    const mode = opts.mode === 'replace' ? 'replace' : 'append';

    // replace 模式：先软删除本项目已有分集（角色等共享资源不受影响，由调用方/重置流程处理）
    if (mode === 'replace') {
      const existing = await this.prisma.episode.findMany({
        where: { dramaId, deletedAt: null },
        select: { id: true },
      });
      for (const e of existing) {
        await this.prisma.$transaction(async (tx) => {
          await tx.storyboard.updateMany({
            where: { episodeId: e.id },
            data: { deletedAt: new Date(), status: 'cancelled' },
          });
          await tx.prop.updateMany({
            where: { episodeId: e.id },
            data: { deletedAt: new Date() },
          });
          await tx.scene.updateMany({
            where: { episodeId: e.id },
            data: { deletedAt: new Date() },
          });
          await tx.episode.update({
            where: { id: e.id },
            data: { deletedAt: new Date() },
          });
        });
        this.cleanupMaterials(dramaId, e.id);
      }
    }

    // 取当前最大集号作为起始，避免 append 时集号冲突
    const max = await this.prisma.episode.aggregate({
      where: { dramaId, deletedAt: null },
      _max: { episodeNumber: true },
    });
    let nextNumber = (max._max.episodeNumber ?? 0) + 1;

    const created: Array<{ id: number; episodeNumber: number; title: string }> = [];
    for (const block of blocks) {
      const episodeNumber = block.number ?? nextNumber;
      nextNumber = Math.max(nextNumber, episodeNumber + 1);
      const title = block.title || `第${episodeNumber}集：新分集`;
      const ep = await this.prisma.episode.create({
        data: {
          dramaId,
          title,
          description: null,
          episodeNumber,
          status: 'draft',
          merged: false,
          scriptText: block.body,
        },
      });
      await this.ensureUploadDir(dramaId, ep.id);
      created.push({ id: ep.id, episodeNumber, title });
    }

    return { imported: created.length, episodes: created };
  }

  /**
   * 把整本剧本文本按「第N集」标题行拆分为块。
   * 标题行匹配：`第N集` 开头（N 为数字），可带冒号、空格、中文顿号等分隔，
   * 后续为标题文字。正文为标题行之后、下一标题行之前的全部内容。
   */
  private splitScriptByEpisode(text: string): Array<{
    number?: number;
    title?: string;
    body: string;
  }> {
    const lines = text.split('\n');
    const blocks: Array<{ number?: number; title?: string; body: string }> = [];
    let current: { number?: number; title?: string; body: string[] } | null = null;

    const flush = () => {
      if (current) {
        const body = current.body.join('\n').trim();
        if (body) {
          blocks.push({
            number: current.number,
            title: current.title,
            body,
          });
        }
        current = null;
      }
    };

    const EP_RE = /^第\s*(\d+)\s*集\s*[:：、.\s]*(.*)$/;

    for (const line of lines) {
      const m = line.trim().match(EP_RE);
      if (m) {
        flush();
        const num = parseInt(m[1], 10);
        const title = m[2]?.trim();
        current = {
          number: num,
          title: title ? `第${num}集：${title}` : `第${num}集：新分集`,
          body: [],
        };
      } else if (current) {
        current.body.push(line);
      }
      // 标题行之前的内容（如剧名、前言）忽略
    }
    flush();
    return blocks;
  }

  // 软删除该集的分镜/场景/道具/分集，终止进行中的生成任务；
  // 物理删除该集素材目录 {dramaId}/{episodeId}（异步，不阻塞事件循环）。
  // 角色属整剧共享，不受分集重置影响。
  async remove(id: number) {
    const exist = await this.prisma.episode.findFirst({
      where: { id, deletedAt: null },
    });
    if (!exist) throw new NotFoundException(`分集 ${id} 不存在`);

    await this.prisma.$transaction(async (tx) => {
      await tx.storyboard.updateMany({
        where: { episodeId: id },
        data: { deletedAt: new Date(), status: 'cancelled' },
      });
      await tx.prop.updateMany({
        where: { episodeId: id },
        data: { deletedAt: new Date() },
      });
      await tx.scene.updateMany({
        where: { episodeId: id },
        data: { deletedAt: new Date() },
      });
      await tx.episode.update({
        where: { id },
        data: { deletedAt: new Date() },
      });
    });

    this.cleanupMaterials(exist.dramaId, id);

    return { id, deleted: true };
  }

  private async ensureUploadDir(dramaId: number, episodeId: number) {
    const root = uploadRoot();
    if (!root) return;
    await fs.promises.mkdir(path.join(root, String(dramaId), String(episodeId)), {
      recursive: true,
    });
  }

  private cleanupMaterials(dramaId: number, episodeId: number) {
    const root = uploadRoot();
    if (!root) return;
    const target = path.join(root, String(dramaId), String(episodeId));
    fs.promises
      .rm(target, { recursive: true, force: true })
      .catch((e) => console.warn(`[EpisodeService] 素材目录删除失败: ${e.message}`));
  }
}
