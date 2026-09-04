import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateCharacterDto,
  UpdateCharacterDto,
  CreateSceneDto,
  UpdateSceneDto,
  CreatePropDto,
  UpdatePropDto,
  CreateStoryboardDto,
  UpdateStoryboardDto,
} from './dto/script.dto';

@Injectable()
export class ScriptService {
  constructor(private readonly prisma: PrismaService) {}

  // ==================== 角色（整剧共享） ====================

  async listCharacters(dramaId?: number) {
    const rows = await this.prisma.character.findMany({
      where: { deletedAt: null, ...(dramaId ? { dramaId } : {}) },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        dramaId: true,
        name: true,
        dialect: true,
        role: true,
        roleLabel: true,
        appearance: true,
        anchors: true,
        imageUrl: true,
        sourceUrl: true,
        intro: true,
        referenceImageUrl: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { storyboards: { where: { deletedAt: null } } } },
      },
    });
    return rows.map(({ _count, ...c }) => ({
      ...c,
      storyboardCount: _count.storyboards,
    }));
  }

  async createCharacter(dto: CreateCharacterDto) {
    const drama = await this.prisma.drama.findFirst({
      where: { id: dto.dramaId, deletedAt: null },
    });
    if (!drama) throw new NotFoundException(`项目 ${dto.dramaId} 不存在`);
    return this.prisma.character.create({
      data: {
        dramaId: dto.dramaId,
        name: dto.name?.trim() || '未命名角色',
        dialect: dto.dialect ?? null,
        role: dto.role ?? 'supporting',
        roleLabel: dto.roleLabel ?? '配角',
        appearance: dto.appearance ?? null,
        anchors: dto.anchors ?? null,
        imageUrl: dto.imageUrl ?? null,
        referenceImageUrl: dto.referenceImageUrl ?? null,
        intro: dto.intro ?? null,
      },
    });
  }

  async updateCharacter(id: number, dto: UpdateCharacterDto) {
    const exist = await this.prisma.character.findFirst({
      where: { id, deletedAt: null },
    });
    if (!exist) throw new NotFoundException(`角色 ${id} 不存在`);
    const data: any = {};
    if (dto.name !== undefined) data.name = dto.name?.trim() || '未命名角色';
    if (dto.dialect !== undefined) data.dialect = dto.dialect ?? null;
    if (dto.role !== undefined) data.role = dto.role ?? null;
    if (dto.roleLabel !== undefined) data.roleLabel = dto.roleLabel ?? null;
    if (dto.appearance !== undefined) data.appearance = dto.appearance ?? null;
    if (dto.anchors !== undefined) data.anchors = dto.anchors ?? null;
    if (dto.imageUrl !== undefined) data.imageUrl = dto.imageUrl ?? null;
    if (dto.referenceImageUrl !== undefined)
      data.referenceImageUrl = dto.referenceImageUrl ?? null;
    if (dto.intro !== undefined) data.intro = dto.intro ?? null;
    return this.prisma.character.update({ where: { id }, data });
  }

  async deleteCharacter(id: number) {
    const exist = await this.prisma.character.findFirst({
      where: { id, deletedAt: null },
    });
    if (!exist) throw new NotFoundException(`角色 ${id} 不存在`);
    await this.prisma.$transaction([
      this.prisma.storyboard.updateMany({
        where: { characterId: id, deletedAt: null },
        data: { characterId: null },
      }),
      this.prisma.character.update({
        where: { id },
        data: { deletedAt: new Date() },
      }),
    ]);
    return { id, deleted: true };
  }

  // ==================== 场景（分集归属） ====================

  async listScenes(episodeId?: number) {
    const rows = await this.prisma.scene.findMany({
      where: { deletedAt: null, ...(episodeId ? { episodeId } : {}) },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        episodeId: true,
        location: true,
        time: true,
        description: true,
        prompt: true,
        quadPrompt: true,
        imageUrl: true,
        referenceImageUrl: true,
        sourceUrl: true,
        useQuadGrid: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { storyboards: { where: { deletedAt: null } } } },
      },
    });
    return rows.map(({ _count, ...s }) => ({
      ...s,
      storyboardCount: _count.storyboards,
    }));
  }

  async createScene(dto: CreateSceneDto) {
    await this.assertEpisode(dto.episodeId);
    return this.prisma.scene.create({
      data: {
        episodeId: dto.episodeId,
        location: dto.location?.trim() || '未命名场景',
        time: dto.time ?? null,
        description: dto.description ?? null,
        prompt: dto.prompt ?? null,
        quadPrompt: dto.quadPrompt ?? null,
        imageUrl: dto.imageUrl ?? null,
        referenceImageUrl: dto.referenceImageUrl ?? null,
        useQuadGrid: dto.useQuadGrid ?? false,
      },
    });
  }

  async updateScene(id: number, dto: UpdateSceneDto) {
    const exist = await this.prisma.scene.findFirst({
      where: { id, deletedAt: null },
    });
    if (!exist) throw new NotFoundException(`场景 ${id} 不存在`);
    const data: any = {};
    if (dto.location !== undefined)
      data.location = dto.location?.trim() || '未命名场景';
    if (dto.time !== undefined) data.time = dto.time ?? null;
    if (dto.description !== undefined)
      data.description = dto.description ?? null;
    if (dto.prompt !== undefined) data.prompt = dto.prompt ?? null;
    if (dto.quadPrompt !== undefined) data.quadPrompt = dto.quadPrompt ?? null;
    if (dto.imageUrl !== undefined) data.imageUrl = dto.imageUrl ?? null;
    if (dto.referenceImageUrl !== undefined)
      data.referenceImageUrl = dto.referenceImageUrl ?? null;
    if (dto.useQuadGrid !== undefined) data.useQuadGrid = dto.useQuadGrid ?? false;
    return this.prisma.scene.update({ where: { id }, data });
  }

  async deleteScene(id: number) {
    const exist = await this.prisma.scene.findFirst({
      where: { id, deletedAt: null },
    });
    if (!exist) throw new NotFoundException(`场景 ${id} 不存在`);
    await this.prisma.$transaction([
      this.prisma.storyboard.updateMany({
        where: { sceneId: id, deletedAt: null },
        data: { sceneId: null },
      }),
      this.prisma.scene.update({
        where: { id },
        data: { deletedAt: new Date() },
      }),
    ]);
    return { id, deleted: true };
  }

  // ==================== 道具（分集归属） ====================

  async listProps(episodeId?: number) {
    const rows = await this.prisma.prop.findMany({
      where: { deletedAt: null, ...(episodeId ? { episodeId } : {}) },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        episodeId: true,
        name: true,
        type: true,
        description: true,
        prompt: true,
        imageUrl: true,
        referenceImageUrl: true,
        sourceUrl: true,
        useQuadGrid: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { storyboards: { where: { deletedAt: null } } } },
      },
    });
    return rows.map(({ _count, ...p }) => ({
      ...p,
      storyboardCount: _count.storyboards,
    }));
  }

  async createProp(dto: CreatePropDto) {
    await this.assertEpisode(dto.episodeId);
    return this.prisma.prop.create({
      data: {
        episodeId: dto.episodeId,
        name: dto.name?.trim() || '未命名道具',
        type: dto.type ?? null,
        description: dto.description ?? null,
        prompt: dto.prompt ?? null,
        imageUrl: dto.imageUrl ?? null,
        referenceImageUrl: dto.referenceImageUrl ?? null,
        useQuadGrid: dto.useQuadGrid ?? false,
      },
    });
  }

  async updateProp(id: number, dto: UpdatePropDto) {
    const exist = await this.prisma.prop.findFirst({
      where: { id, deletedAt: null },
    });
    if (!exist) throw new NotFoundException(`道具 ${id} 不存在`);
    const data: any = {};
    if (dto.name !== undefined) data.name = dto.name?.trim() || '未命名道具';
    if (dto.type !== undefined) data.type = dto.type ?? null;
    if (dto.description !== undefined)
      data.description = dto.description ?? null;
    if (dto.prompt !== undefined) data.prompt = dto.prompt ?? null;
    if (dto.imageUrl !== undefined) data.imageUrl = dto.imageUrl ?? null;
    if (dto.referenceImageUrl !== undefined)
      data.referenceImageUrl = dto.referenceImageUrl ?? null;
    if (dto.useQuadGrid !== undefined) data.useQuadGrid = dto.useQuadGrid ?? false;
    return this.prisma.prop.update({ where: { id }, data });
  }

  async deleteProp(id: number) {
    const exist = await this.prisma.prop.findFirst({
      where: { id, deletedAt: null },
    });
    if (!exist) throw new NotFoundException(`道具 ${id} 不存在`);
    await this.prisma.$transaction([
      this.prisma.storyboard.updateMany({
        where: { propId: id, deletedAt: null },
        data: { propId: null },
      }),
      this.prisma.prop.update({
        where: { id },
        data: { deletedAt: new Date() },
      }),
    ]);
    return { id, deleted: true };
  }

  // ==================== 分镜（分集归属） ====================

  async listStoryboards(episodeId?: number) {
    const rows = await this.prisma.storyboard.findMany({
      where: { deletedAt: null, ...(episodeId ? { episodeId } : {}) },
      orderBy: { number: 'asc' },
      include: {
        character: { select: { id: true, name: true, roleLabel: true } },
        scene: { select: { id: true, location: true, time: true } },
        prop: { select: { id: true, name: true, type: true } },
      },
    });
    return rows.map(
      ({ character, scene, prop, deletedAt, episodeId, ...rtn }) => ({
        ...rtn,
        characterName: character?.name ?? null,
        sceneLocation: scene?.location ?? null,
        sceneTime: scene?.time ?? null,
        propName: prop?.name ?? null,
      }),
    );
  }

  async createStoryboard(dto: CreateStoryboardDto) {
    await this.assertEpisode(dto.episodeId);
    const max = await this.prisma.storyboard.aggregate({
      where: { episodeId: dto.episodeId, deletedAt: null },
      _max: { number: true },
    });
    const number = dto.number ?? (max._max.number ?? 0) + 1;
    return this.prisma.storyboard.create({
      data: {
        episodeId: dto.episodeId,
        number,
        characterId: dto.characterId ?? null,
        sceneId: dto.sceneId ?? null,
        propId: dto.propId ?? null,
        dialogue: dto.dialogue ?? null,
        narration: dto.narration ?? null,
        sceneDescription: dto.sceneDescription ?? null,
        motionDescription: dto.motionDescription ?? null,
        emotion: dto.emotion ?? 'neutral',
        duration: dto.duration ?? 5,
        dialect: dto.dialect ?? null,
        referenceImageUrl: dto.referenceImageUrl ?? null,
        status: dto.status ?? 'pending',
      },
    });
  }

  async updateStoryboard(id: number, dto: UpdateStoryboardDto) {
    const exist = await this.prisma.storyboard.findFirst({
      where: { id, deletedAt: null },
    });
    if (!exist) throw new NotFoundException(`分镜 ${id} 不存在`);
    const data: any = {};
    if (dto.number !== undefined) data.number = dto.number;
    if (dto.characterId !== undefined) data.characterId = dto.characterId;
    if (dto.sceneId !== undefined) data.sceneId = dto.sceneId;
    if (dto.propId !== undefined) data.propId = dto.propId;
    if (dto.dialogue !== undefined) data.dialogue = dto.dialogue;
    if (dto.narration !== undefined) data.narration = dto.narration;
    if (dto.sceneDescription !== undefined)
      data.sceneDescription = dto.sceneDescription;
    if (dto.motionDescription !== undefined)
      data.motionDescription = dto.motionDescription;
    if (dto.emotion !== undefined) data.emotion = dto.emotion;
    if (dto.duration !== undefined) data.duration = dto.duration;
    if (dto.dialect !== undefined) data.dialect = dto.dialect;
    if (dto.imageUrl !== undefined) data.imageUrl = dto.imageUrl;
    if (dto.lastFrameUrl !== undefined) data.lastFrameUrl = dto.lastFrameUrl;
    if (dto.videoUrl !== undefined) data.videoUrl = dto.videoUrl;
    if (dto.referenceImageUrl !== undefined)
      data.referenceImageUrl = dto.referenceImageUrl ?? null;
    if (dto.imagePrompt !== undefined) data.imagePrompt = dto.imagePrompt;
    if (dto.videoPrompt !== undefined) data.videoPrompt = dto.videoPrompt;
    if (dto.status !== undefined) data.status = dto.status;
    return this.prisma.storyboard.update({ where: { id }, data });
  }

  // 重排分镜：ids 顺序即最终顺序，依次重写 number
  async reorderStoryboards(episodeId: number, ids: number[]) {
    await this.assertEpisode(episodeId);
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new BadRequestException('ids 不能为空');
    }
    await this.prisma.$transaction(
      ids.map((sid, idx) =>
        this.prisma.storyboard.update({
          where: { id: sid },
          data: { number: idx + 1 },
        }),
      ),
    );
    return { episodeId, reordered: ids.length };
  }

  async deleteStoryboard(id: number) {
    const exist = await this.prisma.storyboard.findFirst({
      where: { id, deletedAt: null },
    });
    if (!exist) throw new NotFoundException(`分镜 ${id} 不存在`);
    await this.prisma.$transaction([
      this.prisma.storyboard.update({
        where: { id },
        data: { deletedAt: new Date(), status: 'cancelled' },
      }),
      // 删除后重排后续分镜编号，保持连续
      this.prisma.$executeRawUnsafe(
        `UPDATE Storyboard SET number = number - 1
         WHERE episodeId = ? AND deletedAt IS NULL AND number > ?`,
        exist.episodeId,
        exist.number,
      ),
    ]);
    return { id, deleted: true };
  }

  private async assertEpisode(episodeId: number) {
    const episode = await this.prisma.episode.findFirst({
      where: { id: episodeId, deletedAt: null },
    });
    if (!episode) throw new NotFoundException(`分集 ${episodeId} 不存在`);
  }
}