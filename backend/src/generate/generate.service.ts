import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { LogBusService } from './log-bus.service';
import { AIProviderFactory } from '../ai/ai-provider.factory';
import { RateLimitService } from '../ai/rate-limit.service';
import { StorageService, StoredAsset } from '../ai/storage.service';
import { PromptService } from '../ai/prompt.service';
import { GenStyle, anchorStyleTag } from '../ai/prompt.service';
import { FfmpegService } from '../ai/ffmpeg.service';
import { ProviderAuthError, ProviderTransientError } from '../ai/provider.types';
// 剧本拆解的纯逻辑已抽离到 script-parse.util.ts（无 IO，可单测）
import {
  ParsedScript,
  CHUNK_CHARS,
  splitScriptChunks,
  mergeParsed,
  extractJsonObject,
  normStr,
  normEmotion,
  normDuration,
  normalizeNameKey,
  locTimeKey,
  matchName,
  normalizeParsedScript,
} from './script-parse.util';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 分集清单便于日志展示：「第1集、第2集...」 */
function episodeListLabel(eps: Array<{ episodeNumber: number | null }>) {
  if (!eps.length) return '0 集';
  if (eps.length === 1) return `第 ${eps[0].episodeNumber} 集`;
  return `${eps.length} 集（第 ${eps.map((e) => e.episodeNumber).join('/')} 集）`;
}

const DIALECT_LABEL: Record<string, string> = {
  standard: '标准普通话',
  zh_xian: '西安话',
  zh_dongbei: '东北话',
  zh_yueyu: '粤语',
  zh_chengdu: '成都话',
  zh_shanghai: '上海话',
};

/** 分集生成一致性配置（genCfg JSON，缺省全剧统一：卡通 + 中文 + 禁止唱词） */
export interface EpisodeGenCfg {
  language: string;
  allowSinging: boolean;
  artStyle?: string;
}
const DEFAULT_GEN_CFG: EpisodeGenCfg = {
  language: 'zh-CN',
  allowSinging: false,
  artStyle: 'cartoon',
};

/** 一键生成分步选项（缺省 = 素材四步：角色/场景/道具/分镜首尾帧） */
export interface GenerateEpisodeOpts {
  steps?: {
    characters?: boolean;
    scenes?: boolean;
    props?: boolean;
    storyboardImages?: boolean;
    storyboardVideos?: boolean;
    merge?: boolean;
  };
}

/** v2.5-flash 单段视频仅支持 4–12 秒 */
const clampSeconds = (duration?: number | null) =>
  String(Math.min(12, Math.max(4, Math.round(duration ?? 5))));

/**
 * 首帧 VLM 自动质检的最大生成次数（含首次）。
 * 取 2：审核不合格时再重画一次并把问题追加进提示词；
 * 每多一次就多一轮生图开销（生图远贵于审核），因此不做更多次重试。
 */
const AUDIT_MAX_ATTEMPT = 2;

/**
 * 分镜首帧参考图上限（Agnes Image Flash 硬限制，超出直接 HTTP 400）。
 * 官方参考：reference 模式最多 5 张。
 */
export const FIRST_FRAME_REF_CAP = 5;

/**
 * 分镜首帧参考图候选（尚未做预算裁剪，也尚未解析成可传输的 uri）
 */
export interface FirstFrameRefCandidate {
  kind: 'character' | 'scene' | 'prop' | 'tail';
  name: string;
  /** 本地 /uploads 路径，需转 Data URI */
  url?: string | null;
  /** 远端原始直链，可直接作为参考图 */
  remote?: string | null;
  /** 已解析好的参考图（远端直链或 Data URI），存在时优先 */
  uri?: string | null;
}

/** 实际注入的参考图（uri 必存在，顺序即注入顺序） */
export interface FirstFrameRef extends FirstFrameRefCandidate {
  uri: string;
}

/** 参考图优先级分配结果 */
export interface FirstFrameRefAllocation {
  /** 实际采纳的参考图（顺序即注入顺序，第 1 张 = 主体） */
  refs: FirstFrameRef[];
  /** 因预算不足被丢弃的角色名 */
  droppedCharacters: string[];
  /** 因预算不足被丢弃的道具名 */
  droppedProps: string[];
  /** 场景图是否被丢弃 */
  sceneDropped: boolean;
}

/**
 * 首帧参考图优先级分配（纯函数，便于单测）。
 *
 * 优先级：角色立绘 > 场景图 > 道具图 > 上一镜尾帧。
 * 依据：
 * - 官方示例「第一个图 = 主体」，角色立绘必须排最前，否则身份会被场景/道具稀释；
 * - 场景图是场景一致性的唯一来源（此前完全没注入，是「分镜很烂」的第一根因）；
 * - 尾帧仅保证镜头连续，代价是可能带入上一镜的元素，因此优先级最低。
 *
 * 场景图排在道具之前，是因为道具数量不可控（多选道具可达数个），
 * 而场景对本镜几乎是必需项。
 */
export function allocateFirstFrameRefs(
  candidates: FirstFrameRefCandidate[],
  cap: number = FIRST_FRAME_REF_CAP,
): FirstFrameRefAllocation {
  const order: Record<FirstFrameRefCandidate['kind'], number> = {
    character: 0,
    scene: 1,
    prop: 2,
    tail: 3,
  };
  // 候选必须已有可传输的 uri 才参与分配（url/remote 尚未解析的先跳过）
  const usable = candidates.filter((c): c is FirstFrameRef => Boolean(c.uri));
  // 稳定排序：同类保持输入顺序（角色顺序 = 出场重要性，主体角色排在前面）
  const sorted = [...usable].sort((a, b) => order[a.kind] - order[b.kind]);

  const refs: FirstFrameRef[] = [];
  const droppedCharacters: string[] = [];
  const droppedProps: string[] = [];
  let sceneDropped = false;

  // 场景图与说话人同为 P0（同框人数一多，角色必然挤掉场景图）。
  // 这里给场景预留 1 个名额：非说话人角色再多，也不能把场景一致性整个挤没。
  const hasScene = sorted.some((c) => c.kind === 'scene');
  const otherCap = hasScene ? Math.max(0, cap - 1) : cap;
  let nonSceneUsed = 0;

  for (const c of sorted) {
    if (c.kind === 'scene') {
      if (refs.length < cap) refs.push(c);
      else sceneDropped = true;
      continue;
    }
    if (nonSceneUsed < otherCap) {
      refs.push(c);
      nonSceneUsed++;
      continue;
    }
    if (c.kind === 'character') droppedCharacters.push(c.name);
    else if (c.kind === 'prop') droppedProps.push(c.name);
    // tail 被丢弃属正常，无需上报
  }

  // 输出顺序固定为 角色 → 场景 → 道具 → 尾帧（官方：第 1 张 = 主体）
  refs.sort((a, b) => order[a.kind] - order[b.kind]);

  return { refs, droppedCharacters, droppedProps, sceneDropped };
}
type LoadedStoryboard = {
  id: number;
  episodeId: number;
  number: number;
  dialogue: string | null;
  narration: string | null;
  sceneDescription: string | null;
  motionDescription: string | null;
  emotion: string | null;
  duration: number | null;
  imageUrl: string | null;
  sourceUrl: string | null;
  lastFrameUrl: string | null;
  lastFrameSourceUrl: string | null;
  imagePrompt: string | null;
  videoPrompt: string | null;
  audioUrl: string | null;
  videoUrl: string | null;
  dialect: string | null;
  character: any;
  characters: any[];
  scene: any;
  prop: any;
  props: any[];
  characterIds: number[];
  propIds: number[];
  episode: { id: number; dramaId: number; drama?: { dialect?: string | null } | null };
};

/**
 * 生成引擎（计划 §六 / 开发文档 §4）
 * 对外接口一律「立即返回 + 后台执行」，进度与结果通过 SSE 日志推送，
 * 避免生图/生视频的长耗时把 HTTP 请求拖到超时。
 */
@Injectable()
export class GenerateService {
  /** 整集任务锁 */
  private running = new Map<number, boolean>();
  /** 整剧成片任务锁（generate-all） */
  private dramaRunning = new Set<number>();
  /** 单分镜任务锁 */
  private sbRunning = new Set<number>();
  /** 单分镜配音锁（防重入） */
  private dubRunning = new Set<number>();
  /** 整集配音锁 */
  private dubRunningEpisode = new Set<number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly logBus: LogBusService,
    private readonly factory: AIProviderFactory,
    private readonly rate: RateLimitService,
    private readonly storage: StorageService,
    private readonly prompt: PromptService,
    private readonly ffmpeg: FfmpegService,
  ) {}

  // ==================== ① 角色形象 ====================

  async generateCharacter(characterId: number) {
    const c = await this.prisma.character.findFirst({
      where: { id: characterId, deletedAt: null },
    });
    if (!c) throw new NotFoundException(`角色 ${characterId} 不存在`);
    const episodeId = await this.firstEpisodeIdOfDrama(c.dramaId);
    const style = await this.resolveGenCfgOfEpisode(episodeId);
    this.fire(episodeId, 'asset', () => this.runCharacter(c, episodeId, style));
    return { started: true, episodeId, characterId: c.id };
  }

  private async runCharacter(c: any, episodeId: number, style?: GenStyle) {
    const tag = `角色「${c.name}」`;

    // 先提炼视觉锚点（跨分镜一致性基础）；
    // 锚点内嵌风格标记，切换画面风格后会自动重提炼
    const styleTag = anchorStyleTag(style);
    let anchors: string | null = c.anchors;
    if (!anchors || !anchors.includes(styleTag)) {
      anchors = await this.prompt.buildCharacterAnchorText(c, style);
      await this.prisma.character.update({
        where: { id: c.id },
        data: { anchors },
      });
      this.log(episodeId, 'success', `${tag} 视觉锚点已生成`);
    }

    const asset = await this.image({
      episodeId,
      // 角色形象属整剧共享资源，落盘到 {dramaId}/0/（剧集级目录），
      // 避免重置某个分集时把整剧角色图连带物理删除
      saveDirId: 0,
      dramaId: c.dramaId,
      label: `${tag} 形象`,
      prompt: this.prompt.characterImagePrompt({ ...c, anchors }, style),
      filename: `char-${c.id}-${Date.now()}.png`,
      ratio: '9:16',
    });
    if (asset) {
      const oldUrl = c.imageUrl;
      const data: any = { imageUrl: asset.url, sourceUrl: asset.remote ?? null };

      // 立绘生成后回读实际形象（含服装颜色与款式）回写锚点：
      // 生图模型可能偏离文字设定（如黄T恤画成蓝马甲），锚点以「立绘实际内容」为准，
      // 后续分镜首帧/视频的服装锁定才有唯一可信的文本依据。
      if (asset.abs) {
        try {
          const dataUri = await this.storage.toDataUri(asset.abs);
          if (dataUri) {
            const desc = await this.prompt.describeImage(dataUri, 'characterPortrait');
            const baked = desc ? this.prompt.anchorFromDescription(desc, style) : '';
            if (baked) {
              data.anchors = baked;
              this.log(episodeId, 'info', `${tag} 已按立绘实际形象回写视觉锚点（含服装）`);
            }
          }
        } catch (e: any) {
          this.log(episodeId, 'warn', `${tag} 立绘回读锚点失败（沿用文字锚点）：${e.message}`);
        }
      }

      await this.prisma.character.update({
        where: { id: c.id },
        data,
      });
      if (oldUrl && oldUrl !== asset.url) {
        await this.storage.removeLocalFiles([oldUrl]);
      }
      this.logBus.emit(episodeId, {
        type: 'asset',
        data: { kind: 'character', id: c.id, imageUrl: asset.url, sourceUrl: asset.remote ?? null },
      });
      this.log(episodeId, 'success', `${tag} 形象生成完成`);
    }
  }

  // ==================== ② 场景 ====================

  async generateScene(sceneId: number, opts: { quad?: boolean; force?: boolean } = {}) {
    const s = await this.prisma.scene.findFirst({
      where: { id: sceneId, deletedAt: null },
      include: { episode: true },
    });
    if (!s) throw new NotFoundException(`场景 ${sceneId} 不存在`);
    if (s.imageUrl && !opts.force) {
      this.log(s.episodeId, 'info', `场景「${s.location}」已有图，跳过`);
      return { started: false, episodeId: s.episodeId, reason: 'already_generated' };
    }
    const style = await this.resolveGenCfgOfEpisode(s.episodeId);
    this.fire(s.episodeId, 'asset', () => this.runScene(s, opts, style));
    return { started: true, episodeId: s.episodeId, sceneId: s.id };
  }

  private async runScene(s: any, opts: { quad?: boolean } = {}, style?: GenStyle) {
    // 四宫格已停用（方案 B-2）：项目内没有图像切割代码，四宫格产物是一张 2x2 拼图，
    // 一旦被当作「单张场景参考图」注入首帧，模型会把拼图当成完整画面 → 反而更糟。
    // 统一生成单图，等将来引入 sharp 切图（quadUrls）后再恢复。
    const quad = false;
    const tag = `场景「${s.location}」（单图）`;
    const charCtx = await this.roleNameContext(s.episode.dramaId);
    const asset = await this.image({
      episodeId: s.episodeId,
      dramaId: s.episode.dramaId,
      label: tag,
      prompt: this.prompt.sceneImagePrompt(s, quad, style, charCtx),
      filename: `scene-${s.id}-${quad ? 'quad' : 'single'}-${Date.now()}.png`,
      ratio: '9:16',
    });
    if (asset) {
      const oldUrl = s.imageUrl;
      await this.prisma.scene.update({
        where: { id: s.id },
        data: {
          imageUrl: asset.url,
          sourceUrl: asset.remote ?? null,
          // 强制落 false：避免历史四宫格标记残留，导致旧拼图被当单图参考注入
          useQuadGrid: false,
        },
      });
      this.logBus.emit(s.episodeId, {
        type: 'asset',
        data: { kind: 'scene', id: s.id, imageUrl: asset.url, sourceUrl: asset.remote ?? null },
      });
      if (oldUrl && oldUrl !== asset.url) {
        await this.storage.removeLocalFiles([oldUrl]);
      }
      this.log(s.episodeId, 'success', `${tag} 生成完成`);
    }
  }

  // ==================== ③ 道具 ====================

  async generateProp(propId: number, opts: { quad?: boolean; force?: boolean } = {}) {
    const p = await this.prisma.prop.findFirst({
      where: { id: propId, deletedAt: null },
      include: { episode: true },
    });
    if (!p) throw new NotFoundException(`道具 ${propId} 不存在`);
    if (p.imageUrl && !opts.force) {
      this.log(p.episodeId, 'info', `道具「${p.name}」已有图，跳过`);
      return { started: false, episodeId: p.episodeId, reason: 'already_generated' };
    }
    const style = await this.resolveGenCfgOfEpisode(p.episodeId);
    this.fire(p.episodeId, 'asset', () => this.runProp(p, opts, style));
    return { started: true, episodeId: p.episodeId, propId: p.id };
  }

  private async runProp(p: any, opts: { quad?: boolean } = {}, style?: GenStyle) {
    // 同 runScene：四视图已停用（无切图能力，拼图不能当单图参考）
    const quad = false;
    const tag = `道具「${p.name}」（单图）`;
    const charCtx = await this.roleNameContext(p.episode.dramaId);
    const asset = await this.image({
      episodeId: p.episodeId,
      dramaId: p.episode.dramaId,
      label: tag,
      prompt: this.prompt.propImagePrompt(p, quad, style, charCtx),
      filename: `prop-${p.id}-${quad ? 'quad' : 'single'}-${Date.now()}.png`,
      ratio: '1:1',
    });
    if (asset) {
      const oldUrl = p.imageUrl;
      await this.prisma.prop.update({
        where: { id: p.id },
        data: {
          imageUrl: asset.url,
          sourceUrl: asset.remote ?? null,
          useQuadGrid: false, // 同上：四视图已停用
        },
      });
      this.logBus.emit(p.episodeId, {
        type: 'asset',
        data: { kind: 'prop', id: p.id, imageUrl: asset.url, sourceUrl: asset.remote ?? null },
      });
      if (oldUrl && oldUrl !== asset.url) {
        await this.storage.removeLocalFiles([oldUrl]);
      }
      this.log(p.episodeId, 'success', `${tag} 生成完成`);
    }
  }

  // ==================== ④ 分镜参考图（首帧 + 尾帧） ====================

  async generateStoryboardImage(storyboardId: number, opts: { force?: boolean } = {}) {
    const sb = await this.loadStoryboard(storyboardId);
    // 首帧是主体产物，尾帧只是可选的衔接图。
    // 此前用「首帧+尾帧都存在」作为跳过条件，导致尾帧一旦生成失败，
    // 之后每次点击都会把首帧重画一遍 —— 人物形象在反复重画中不断漂移。
    const needTail = this.needsTailFrame(sb);
    const done = sb.imageUrl && (!needTail || sb.lastFrameUrl);
    if (done && !opts.force) {
      this.log(sb.episodeId, 'info', `[分镜#${sb.number}] 参考图已存在，跳过`);
      return { started: false, episodeId: sb.episodeId, reason: 'already_generated' };
    }
    this.fire(sb.episodeId, 'asset', () => this.runStoryboardImage(sb, opts));
    return { started: true, episodeId: sb.episodeId, storyboardId: sb.id };
  }

  /**
   * 是否需要为本镜生成尾帧。
   * 只有存在明确动作/运镜、且画面里有可动主体时才值得生成；
   * 静态对话镜与空镜的尾帧与首帧几乎相同，白花钱且只会放大人物漂移。
   */
  private needsTailFrame(sb: {
    motionDescription?: string | null;
    sceneDescription?: string | null;
    characters?: any[] | null;
    character?: any;
  }): boolean {
    const hasSubject = (sb.characters?.length ?? 0) > 0 || !!sb.character;
    if (!hasSubject) return false; // 空镜无「动作后的结束状态」
    return Boolean((sb.motionDescription || '').trim());
  }

  /**
   * 本镜与上一镜是否属于同一场景。
   * 判据：都挂了场景则比 sceneId；只有一方挂了场景则视为不同场景（宁可不做衔接，
   * 也不能拿别的场景的画面去污染本镜）；双方都没挂场景则视为同一空环境，允许衔接。
   */
  private async isSameSceneAsPrev(sb: { episodeId: number; number: number; sceneId?: number | null }): Promise<boolean> {
    const prev = await this.prisma.storyboard.findFirst({
      where: { episodeId: sb.episodeId, deletedAt: null, number: { lt: sb.number } },
      orderBy: { number: 'desc' },
      select: { sceneId: true },
    });
    if (!prev) return false; // 首镜没有上一镜
    if (prev.sceneId && sb.sceneId) return prev.sceneId === sb.sceneId;
    return !prev.sceneId && !sb.sceneId;
  }

  async runStoryboardImage(
    sb: LoadedStoryboard,
    opts: { force?: boolean } = {},
    style?: GenStyle,
  ) {
    // 与 generateStoryboardImage 保持同一套「是否已完成」判定
    const needTail = this.needsTailFrame(sb);
    if (sb.imageUrl && (!needTail || sb.lastFrameUrl) && !opts.force) return;
    // force 只重画首帧时（首帧已存在、仅缺尾帧），不要丢弃已保存的自定义首帧提示词
    if (opts.force && !(sb.imageUrl && !needTail && !sb.lastFrameUrl)) sb.imagePrompt = null;

    // 记录被替换前的旧文件，新文件落库后物理删除，避免重生成堆积孤儿
    const oldFirst = sb.imageUrl;
    const oldTail = sb.lastFrameUrl;

    const ctx = {
      sb,
      character: sb.character,
      characters: sb.characters,
      scene: sb.scene,
      prop: sb.prop,
      props: sb.props,
      refNames: [] as string[],
      refs: [] as Array<{ kind: 'character' | 'scene' | 'prop' | 'tail'; name: string }>,
      hasTailRef: false,
    };

    // 跨分镜一致性参考：角色立绘（锁定人物外貌与服装）+ 场景图（锁定空间与色调）
    // + 道具图 + 上一镜尾帧（锁定镜头连续）。
    //
    // 硬约束：Agnes 生图参考图上限 5 张，超出会直接 HTTP 400。
    // 必须按优先级裁剪：说话人立绘 > 场景图 > 其他同框角色 > 道具图 > 上一镜尾帧。
    //
    // 注意：本地 /uploads/... 是 Web 路径，必须先转磁盘绝对路径再读 Data URI，
    // 直接丢给 fs.exists 全程 false（Windows 已复现，曾导致角色形象图从未真正注入、
    // 人物与服装完全漂移）；远端 http(s) URL 可直接作为参考图传入。
    const refOf = async (url?: string | null): Promise<string | null> => {
      if (!url) return null;
      const abs = this.storage.absFromUrl(url);
      if (abs) return this.storage.toDataUri(abs);
      return /^https?:\/\//i.test(url) ? url : null;
    };

    const charList: any[] = sb.characters?.length
      ? sb.characters
      : sb.character
        ? [sb.character]
        : [];
    const propList: any[] = sb.props?.length ? sb.props : sb.prop ? [sb.prop] : [];

    // 尾帧衔接只在「同一场景」时才有意义：跨场景时把上一镜尾帧当参考，
    // 模型会把上一场景的环境元素带进新场景（这是分镜观感崩坏的主要来源）。
    // 尾帧优先级最低，因此最后才查询，预算不足时可直接跳过。
    const sameSceneAsPrev = await this.isSameSceneAsPrev(sb);

    // 参考图解析（含 Data URI 转换）后交给纯函数做优先级裁剪，保证分配逻辑可单测。
    const candidates: FirstFrameRefCandidate[] = [
      ...charList.map((c: any) => ({
        kind: 'character' as const,
        name: String(c?.name ?? ''),
        url: c?.imageUrl,
        remote: c?.sourceUrl,
      })),
      ...(sb.scene
        ? [{ kind: 'scene' as const, name: String(sb.scene.location ?? '场景'), url: sb.scene.imageUrl, remote: sb.scene.sourceUrl }]
        : []),
      ...propList.map((p: any) => ({
        kind: 'prop' as const,
        name: String(p?.name ?? ''),
        url: p?.imageUrl,
        remote: p?.sourceUrl,
      })),
    ];
    if (sameSceneAsPrev) {
      const prevTail = await this.prevTailFrame(sb.episodeId, sb.number);
      if (prevTail) {
        const tailUri = await this.storage.toDataUri(prevTail);
        if (tailUri) {
          candidates.push({ kind: 'tail', name: '上一镜尾帧', uri: tailUri });
        }
      }
    }

    // 解析每个候选为可用参考图（远端直链优先，其次本地 Data URI）
    const resolved: Array<FirstFrameRefCandidate & { uri: string }> = [];
    for (const c of candidates) {
      if (!c.url && !c.uri) continue;
      const uri =
        (c.remote && /^https?:\/\//i.test(c.remote) ? c.remote : null) ??
        (await refOf(c.url)) ??
        c.uri ??
        null;
      if (uri) resolved.push({ ...c, uri });
    }

    const alloc = allocateFirstFrameRefs(resolved, FIRST_FRAME_REF_CAP);
    const references = alloc.refs.map((r) => r.uri);
    ctx.refs = alloc.refs.map((r) => ({ kind: r.kind, name: r.name }));
    ctx.refNames = alloc.refs.filter((r) => r.kind === 'character').map((r) => r.name);
    ctx.hasTailRef = alloc.refs.some((r) => r.kind === 'tail');

    const refLabel = alloc.refs.map((r, i) => `${i + 1}=${r.name}`).join('、');
    if (references.length > 0) {
      this.log(
        sb.episodeId,
        'info',
        `[分镜#${sb.number}] 注入参考图 ${references.length}/${FIRST_FRAME_REF_CAP}：${refLabel}`,
      );
    }
    if (alloc.droppedCharacters.length > 0) {
      this.log(
        sb.episodeId,
        'warn',
        `[分镜#${sb.number}] 参考图超限，角色「${alloc.droppedCharacters.join('、')}」未注入形象参考，仅靠文字锚点锁定，易漂移`,
      );
    }
    if (alloc.sceneDropped && sb.scene) {
      this.log(
        sb.episodeId,
        'warn',
        `[分镜#${sb.number}] 场景图未注入（预算不足或场景尚未生成），本镜场景一致性将依赖文字描述`,
      );
    }
    if (alloc.droppedProps.length > 0) {
      this.log(
        sb.episodeId,
        'warn',
        `[分镜#${sb.number}] 参考图超限，道具「${alloc.droppedProps.join('、')}」未注入外观参考`,
      );
    }

    // 仅在需要重画首帧时才注入参考图并调用生图；
    // 补尾帧场景下复用已有首帧，避免把已经稳定的人物形象重画一遍。
    const reuseFirst = Boolean(sb.imageUrl) && !opts.force;
    const firstPrompt = reuseFirst
      ? sb.imagePrompt
      : this.prompt.storyboardImagePrompt(ctx, style);
    let first: StoredAsset | null = null;
    if (reuseFirst) {
      this.log(
        sb.episodeId,
        'info',
        `[分镜#${sb.number}] 复用已有首帧，仅补生成尾帧`,
      );
    } else {
      // VLM 自动质检：生成后立刻比对角色立绘参考图，不合格则换措辞重试。
      // 复用已有的图片理解能力（文本模型），无额外供应商成本；
      // 代价是每镜多一次模型调用（约 10~30s），且仅在真正重画首帧时发生。
      const expectChars = charList.map((c: any) => ({
        name: String(c?.name ?? ''),
        anchor: c?.anchors ?? c?.appearance ?? null,
      }));
      // 仅取角色立绘参考（用于与待检首帧做身份比对，排除场景/道具/尾帧）
      const charRefUris = references.filter((_, i) => ctx.refs[i]?.kind === 'character');
      const refImages = references.length > 0 ? references : undefined;

      let attemptPrompt = firstPrompt ?? '';
      for (let attempt = 1; attempt <= AUDIT_MAX_ATTEMPT; attempt++) {
        first = await this.image({
          episodeId: sb.episodeId,
          dramaId: sb.episode.dramaId,
          label: `[分镜#${sb.number}] 首帧`,
          prompt: attemptPrompt,
          filename: `sb-${sb.number}-first-${Date.now()}.png`,
          ratio: '9:16',
          images: refImages,
        });
        if (!first?.abs) break;

        const frameUri = await this.storage.toDataUri(first.abs);
        const audit = await this.prompt.auditFirstFrame(
          charRefUris,
          frameUri ?? '',
          expectChars,
        );
        if (audit.pass) {
          if (attempt > 1) {
            this.log(
              sb.episodeId,
              'success',
              `[分镜#${sb.number}] 首帧自动质检通过（第 ${attempt} 次生成）`,
            );
          }
          break;
        }

        const last = attempt >= AUDIT_MAX_ATTEMPT;
        this.log(
          sb.episodeId,
          'warn',
          `[分镜#${sb.number}] 首帧自动质检未通过：${audit.issues.join('；')}（${
            last ? '已达重试上限，保留本次结果' : '换措辞重试'
          }）`,
        );
        if (last) break;

        // 不合格产物直接丢弃（尚未落库，删掉即可，避免堆积孤儿文件），
        // 并把质检结论追加进提示词，抬高模型遵守人物/服装锁定的概率。
        await this.storage.removeLocalFiles([first.url]);
        first = null;
        attemptPrompt = `${firstPrompt ?? ''}，${audit.issues.join('；')}，务必严格遵守上述人物形象与服装锁定，不得出现上述问题`;
      }
    }

    const data: any = firstPrompt ? { imagePrompt: firstPrompt } : {};
    if (first) {
      data.imageUrl = first.url;
      data.sourceUrl = first.remote ?? null;
    }
    if (Object.keys(data).length > 0) {
      await this.prisma.storyboard.update({ where: { id: sb.id }, data });
    }
    if (first && oldFirst && oldFirst !== first.url) {
      await this.storage.removeLocalFiles([oldFirst]);
    }
    this.logBus.emit(sb.episodeId, {
      type: 'storyboard',
      data: { id: sb.id, status: 'pending', imageUrl: data.imageUrl ?? sb.imageUrl, lastFrameUrl: sb.lastFrameUrl },
    });

    // 尾帧：仅当本镜确有动作时才生成，且以首帧为参考做图生图，保证同场景同人物
    const currentFirstAbs = this.absOf(data.imageUrl ?? sb.imageUrl);
    const firstRef =
      first?.remote ||
      (first?.abs ? await this.storage.toDataUri(first.abs) : null) ||
      (currentFirstAbs ? await this.storage.toDataUri(currentFirstAbs) : null) ||
      null;
    if (!needTail) {
      this.log(
        sb.episodeId,
        'info',
        `[分镜#${sb.number}] 静态镜/空镜，无需尾帧（跳过生图）`,
      );
      this.log(sb.episodeId, 'success', `[分镜#${sb.number}] 参考图生成完成`);
      return;
    }
    if (firstRef) {
      const tail = await this.image({
        episodeId: sb.episodeId,
        dramaId: sb.episode.dramaId,
        label: `[分镜#${sb.number}] 尾帧`,
        prompt: this.prompt.storyboardLastFramePrompt(ctx, style),
        filename: `sb-${sb.number}-last-${Date.now()}.png`,
        ratio: '9:16',
        images: [firstRef],
      });
      if (tail) {
        await this.prisma.storyboard.update({
          where: { id: sb.id },
          data: {
            lastFrameUrl: tail.url,
            lastFrameSourceUrl: tail.remote ?? null,
          },
        });
        if (oldTail && oldTail !== tail.url) {
          await this.storage.removeLocalFiles([oldTail]);
        }
        this.logBus.emit(sb.episodeId, {
          type: 'storyboard',
          data: { id: sb.id, status: 'pending', imageUrl: data.imageUrl ?? null, lastFrameUrl: tail.url },
        });
      }
    }

    this.log(sb.episodeId, 'success', `[分镜#${sb.number}] 参考图（首帧+尾帧）生成完成`);
  }

  // ==================== ④ 分镜视频 ====================

  async generateStoryboardVideo(storyboardId: number, opts: { force?: boolean } = {}) {
    const sb = await this.loadStoryboard(storyboardId);
    if (this.sbRunning.has(sb.id)) {
      throw new ForbiddenException('该分镜正在生成中');
    }
    if (sb.videoUrl && !opts.force) {
      this.log(sb.episodeId, 'info', `[分镜#${sb.number}] 视频已存在，跳过`);
      return { started: false, episodeId: sb.episodeId, reason: 'already_generated' };
    }
    this.fire(sb.episodeId, 'asset', () => this.runStoryboardVideoFlow(sb, opts));
    return { started: true, episodeId: sb.episodeId, storyboardId: sb.id };
  }

  private async runStoryboardVideoFlow(
    sb: LoadedStoryboard,
    opts: { force?: boolean } = {},
    style?: GenStyle,
  ) {
    this.sbRunning.add(sb.id);
    try {
      if (!sb.imageUrl) {
        this.log(sb.episodeId, 'info', `[分镜#${sb.number}] 无首帧，先生成参考图`);
        await this.runStoryboardImage(sb, { force: opts.force }, style);
      }
      const current = await this.loadStoryboard(sb.id);
      await this.runVideo(current, style, opts.force);
    } finally {
      this.sbRunning.delete(sb.id);
    }
  }

  private async runVideo(sb: LoadedStoryboard, style?: GenStyle, force = false) {
    // force 重生成时丢弃旧提示词，避免被当作「自定义提示词」拼接造成指令冲突
    if (force) sb.videoPrompt = null;
    const ctx = { sb, character: sb.character, characters: sb.characters, scene: sb.scene };
    this.status(sb.episodeId, sb.id, 'generating', 5);

    if (!this.factory.isLive('video')) {
      await sleep(800);
      await this.prisma.storyboard.update({
        where: { id: sb.id },
        data: {
          videoPrompt: this.prompt.videoPrompt(ctx, style, []),
          status: 'finished',
        },
      });
      this.log(
        sb.episodeId,
        'warn',
        `[分镜#${sb.number}] 模拟模式（未配置 AGNES_API_KEY），视频未真正生成`,
      );
      this.status(sb.episodeId, sb.id, 'finished', 100);
      return;
    }

    // —— 模式决策（人物一致性核心）：keyframe（首/尾帧锁定）→ reference（角色形象图）→ text
    // Agnes 要求媒体为可公开访问的 http(s) 地址：生图远端 URL 直接可用；
    // 本地素材仅在配置 PUBLIC_BASE_URL 后可用。
    const firstFrame = this.storage.absoluteUrl(sb.sourceUrl || sb.imageUrl);
    const lastFrame = this.storage.absoluteUrl(
      sb.lastFrameSourceUrl || sb.lastFrameUrl,
    );
    const charList: any[] = sb.characters?.length
      ? sb.characters
      : sb.character
        ? [sb.character]
        : [];
    const charRefPairs = charList
      .map((c: any) => ({
        name: String(c?.name ?? ''),
        url: this.storage.absoluteUrl(c?.sourceUrl || c?.imageUrl),
      }))
      .filter((p: any) => Boolean(p.url))
      .slice(0, 5); // Flash 最多 5 张参考图

    let mode: 'keyframe' | 'reference' | 'text' = 'text';
    if (firstFrame || lastFrame) mode = 'keyframe';
    else if (charRefPairs.length > 0) mode = 'reference';

    const seconds = clampSeconds(sb.duration);
    const provider = this.factory.resolve('video');
    const retryLogger = (attempt: number, delay: number, reason: string) =>
      this.log(
        sb.episodeId,
        'warn',
        `[分镜#${sb.number}] 视频请求重试 ${attempt} 次（${reason}），${Math.round(delay / 1000)}s 后继续`,
      );
    const createVideo = (opts: Record<string, any>, prompt: string) =>
      this.rate.schedule('video', () =>
        this.rate.withRetry(
          `[分镜#${sb.number}] 视频`,
          () =>
            provider.generate('video', {
              prompt,
              options: {
                seconds,
                size: '720P',
                aspectRatio: '9:16',
                n: 1,
                ...opts,
              },
            }),
          retryLogger,
        ),
      );

    let prompt = this.prompt.videoPrompt(
      ctx,
      style,
      mode === 'reference' ? charRefPairs.map((p) => p.name) : [],
    );
    let created;
    try {
      created = await createVideo(
        mode === 'keyframe'
          ? { mode, firstFrame, lastFrame }
          : mode === 'reference'
            ? { mode, images: charRefPairs.map((p) => p.url) }
            : { mode },
        prompt,
      );
      this.log(
        sb.episodeId,
        'info',
        `[分镜#${sb.number}] 视频任务已创建（${mode} 模式${
          mode === 'keyframe' ? '：首尾帧锁定画面' : mode === 'reference' ? '：角色形象参考' : '：纯文生视频'
        }）`,
      );
    } catch (e: any) {
      // keyframe/reference 创建失败（典型：参考 URL 已过期被 4xx 拒绝）→ 降级文生视频重试
      const fatal =
        e instanceof ProviderAuthError || e instanceof ProviderTransientError;
      if (mode === 'text' || fatal) throw e;
      this.log(
        sb.episodeId,
        'warn',
        `[分镜#${sb.number}] ${mode} 模式创建失败（${e?.message ?? e}），降级为文生视频重试`,
      );
      mode = 'text';
      prompt = this.prompt.videoPrompt(ctx, style, []);
      created = await createVideo({ mode }, prompt);
      this.log(sb.episodeId, 'info', `[分镜#${sb.number}] 已降级为文生视频模式创建任务`);
    }

    const taskId = created.taskId!;
    this.log(sb.episodeId, 'info', `[分镜#${sb.number}] 视频任务已创建（${taskId}）`);

    const url = await this.pollVideo(sb, provider, taskId);
    const asset = await this.storage.saveVideo(
      sb.episode.dramaId,
      sb.episodeId,
      `sb-${sb.number}-${Date.now()}.mp4`,
      { url },
    );

    const oldVideo = sb.videoUrl;
    await this.prisma.storyboard.update({
      where: { id: sb.id },
      data: { videoPrompt: prompt, videoUrl: asset.url, status: 'finished' },
    });
    if (oldVideo && oldVideo !== asset.url) {
      // 旧视频及其尾帧 sidecar（xxx.mp4 → xxx-tail.jpg）一并物理删除，避免重生成堆积
      await this.storage.removeLocalFiles([
        oldVideo,
        oldVideo.replace(/\.mp4$/, '-tail.jpg'),
      ]);
    }
    this.logBus.emit(sb.episodeId, {
      type: 'storyboard',
      data: { id: sb.id, status: 'finished', progress: 100, videoUrl: asset.url, audioUrl: sb.audioUrl },
    });
    this.status(sb.episodeId, sb.id, 'finished', 100);
    this.log(
      sb.episodeId,
      'success',
      `[分镜#${sb.number}] 视频生成完成（${clampSeconds(sb.duration)}s · 720P · 9:16）`,
    );

    // 尾帧衔接：提取视频真实尾帧，作为下一镜的画面参考
    await this.linkTailFrame(sb, asset.abs);
  }

  // ==================== 分镜配音（TTS） ====================

  /**
   * 生成本镜对白配音音轨。
   *
   * 【为何此前是死代码】工厂注册了 VolcengineProvider / EdgeTtsProvider 两个 TTS provider，
   * 但全代码库从未调用过 `resolve('tts')`，`Storyboard.audioUrl` 只在读取侧出现、
   * 从未被写入 —— 合成时永远走「保留 AI 原声」，用户配置的方言配音完全不生效。
   * 现补齐写入侧：真实生成 → 落盘 → 写 audioUrl → 合成阶段混入。
   */
  async generateStoryboardAudio(storyboardId: number, opts: { force?: boolean } = {}) {
    const sb = await this.loadStoryboard(storyboardId);
    if (this.dubRunning.has(sb.id)) {
      throw new ForbiddenException('该分镜正在配音中');
    }
    if (sb.audioUrl && !opts.force) {
      this.log(sb.episodeId, 'info', `[分镜#${sb.number}] 配音已存在，跳过`);
      return { started: false, episodeId: sb.episodeId, reason: 'already_generated' };
    }
    this.fire(sb.episodeId, 'asset', () => this.runStoryboardAudio(sb));
    return { started: true, episodeId: sb.episodeId, storyboardId: sb.id };
  }

  /** 批量生成本集全部需要对白的分镜配音 */
  async generateEpisodeAudio(episodeId: number) {
    if (this.dubRunningEpisode.has(episodeId)) {
      throw new ForbiddenException('该分集正在配音中');
    }
    const list = await this.prisma.storyboard.findMany({
      where: { episodeId, deletedAt: null },
      orderBy: { number: 'asc' },
      select: { id: true, number: true, dialogue: true, audioUrl: true },
    });
    const todo = list.filter((s) => (s.dialogue ?? '').trim() && !s.audioUrl);
    if (todo.length === 0) {
      return { started: false, episodeId, reason: 'nothing_to_do' };
    }
    this.dubRunningEpisode.add(episodeId);
    this.fire(episodeId, 'episode', async () => {
      try {
        for (const item of todo) {
          try {
            const sb = await this.loadStoryboard(item.id);
            await this.runStoryboardAudio(sb);
          } catch (e: any) {
            this.log(episodeId, 'error', `[分镜#${item.number}] 配音失败：${e.message}`);
          }
        }
        this.log(episodeId, 'success', `🎙️ 本集配音完成（${todo.length} 个分镜）`);
      } finally {
        this.dubRunningEpisode.delete(episodeId);
      }
    });
    return { started: true, episodeId, count: todo.length };
  }

  /** 真实执行配音：对白 → TTS → 落盘 → 写 audioUrl */
  async runStoryboardAudio(sb: LoadedStoryboard) {
    const text = (sb.dialogue ?? '').trim();
    if (!text) {
      this.log(sb.episodeId, 'info', `[分镜#${sb.number}] 无对白，跳过配音`);
      return;
    }
    this.dubRunning.add(sb.id);
    try {
      const dialect = this.resolveDialectKey({
        dialect: sb.dialect,
        character: sb.characters?.find((c: any) => c?.id === sb.characterIds[0]) ?? sb.character,
        dramaDialect: sb.episode?.drama?.dialect,
      });
      const label = `[分镜#${sb.number}] 配音`;

      if (!this.factory.isLive('tts')) {
        this.log(
          sb.episodeId,
          'warn',
          `${label}：无可用 TTS Provider，跳过（分镜将保留 AI 视频原声）`,
        );
        return;
      }

      const provider = this.factory.resolve('tts');
      const res = await this.rate.withRetry(
        label,
        () =>
          provider.generate('tts', {
            prompt: text,
            options: { dialect },
          }),
        (attempt, delay, reason) =>
          this.log(
            sb.episodeId,
            'warn',
            `${label}：重试 ${attempt} 次（${reason}），${Math.round(delay / 1000)}s 后继续`,
          ),
      );

      const asset = await this.storage.saveAudio(
        sb.episode.dramaId,
        sb.episodeId,
        `sb-${sb.number}-dub-${Date.now()}.mp3`,
        { url: res.url, b64: res.b64 },
      );
      if (!asset.url) {
        this.log(sb.episodeId, 'warn', `${label}：音频落盘失败`);
        return;
      }

      const old = sb.audioUrl;
      await this.prisma.storyboard.update({
        where: { id: sb.id },
        data: { audioUrl: asset.url },
      });
      if (old && old !== asset.url) {
        await this.storage.removeLocalFiles([old]);
      }
      this.logBus.emit(sb.episodeId, {
        type: 'storyboard',
        data: { id: sb.id, audioUrl: asset.url },
      });
      this.log(
        sb.episodeId,
        'success',
        `${label} 完成（${DIALECT_LABEL[dialect] ?? '标准普通话'} · ${provider.name}）`,
      );
    } finally {
      this.dubRunning.delete(sb.id);
    }
  }

  private async pollVideo(
    sb: LoadedStoryboard,
    provider: ReturnType<AIProviderFactory['resolve']>,
    taskId: string,
  ): Promise<string> {
    const deadline = Date.now() + 15 * 60 * 1000;
    let lastProgress = -1;
    let backoff = 3000;
    while (Date.now() < deadline) {
      try {
        const res = await provider.queryStatus('video', taskId);
        backoff = 3000;
        if (res.status === 'success') {
          if (!res.url) throw new Error('视频任务完成但未返回地址');
          return res.url;
        }
        if (res.status === 'failed') {
          throw new Error(res.error || '视频生成失败');
        }
        const progress = Math.min(95, Math.round(res.progress ?? 0));
        if (progress !== lastProgress) {
          lastProgress = progress;
          this.status(sb.episodeId, sb.id, 'generating', progress);
          this.log(sb.episodeId, 'info', `[分镜#${sb.number}] 视频生成中 ${progress}%`);
        }
      } catch (e: any) {
        // 查询限频（429）/ 服务端抖动（5xx）为瞬时错误，退避后继续轮询；
        // 鉴权/配额错误（401/402/403）直接抛出，触发上层熔断。
        const transient =
          e instanceof ProviderTransientError ||
          /429|5\d\d|rate limit|限频/i.test(e?.message || '');
        const auth =
          e instanceof ProviderAuthError ||
          /401|402|403|鉴权|额度/.test(e?.message || '');
        if (auth) throw e;
        if (!transient) throw e;
        this.log(
          sb.episodeId,
          'warn',
          `[分镜#${sb.number}] 视频状态查询限频，退避 ${Math.round(backoff / 1000)}s 后重试（${e.message}）`,
        );
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 30000);
        continue;
      }
      await sleep(3000);
    }
    throw new Error('视频生成超时（15 分钟）');
  }

  private async linkTailFrame(sb: LoadedStoryboard, videoAbs: string) {
    if (!videoAbs) return;
    const outAbs = videoAbs.replace(/\.mp4$/, '-tail.jpg');
    if (!(await this.ffmpeg.extractLastFrame(videoAbs, outAbs))) return;
    const rel = `/uploads/${sb.episode.dramaId}/${sb.episodeId}/${path.basename(outAbs)}`;
    const oldTail = sb.lastFrameUrl;
    await this.prisma.storyboard.update({
      where: { id: sb.id },
      data: { lastFrameUrl: rel },
    });
    // 被 video 尾帧替换掉的旧 lastFrameUrl（AI 尾帧 png 或旧视频尾帧）已无引用，物理删除
    if (oldTail && oldTail !== rel) {
      await this.storage.removeLocalFiles([oldTail]);
    }
    this.log(sb.episodeId, 'info', `[分镜#${sb.number}] 尾帧已提取，将作为下一镜画面参考`);
  }

  // ==================== 单分镜完整生成（参考图 + 视频） ====================

  async generateStoryboardBySbId(storyboardId: number) {
    const sb = await this.loadStoryboard(storyboardId);
    if (this.sbRunning.has(sb.id)) {
      throw new ForbiddenException('该分镜正在生成中');
    }
    this.fire(sb.episodeId, 'asset', async () => {
      const style = await this.resolveGenCfgOfEpisode(sb.episodeId);
      await this.runStoryboardImage(sb, { force: true }, style);
      const afterImage = await this.loadStoryboard(sb.id);
      await this.runVideo(afterImage, style, true);
    });
    return { started: true, episodeId: sb.episodeId, storyboardId: sb.id };
  }

  // ==================== 一键全流程（①角色→②场景→③道具→④分镜参考图） ====================

  async generateEpisode(episodeId: number, opts: GenerateEpisodeOpts = {}) {
    if (this.running.get(episodeId)) {
      throw new ForbiddenException('该分集已有生成任务进行中');
    }
    const episode = await this.prisma.episode.findFirst({
      where: { id: episodeId, deletedAt: null },
      include: { drama: true },
    });
    if (!episode) throw new NotFoundException(`分集 ${episodeId} 不存在`);

    this.running.set(episodeId, true);
    this.fire(episodeId, 'episode', () =>
      this.runEpisode(episodeId, episode.dramaId, opts),
    );
    return { started: true, episodeId };
  }

  // ==================== 整剧一键成片（全部集数排队跑完整流水线） ====================

  /**
   * 整剧一键成片：把剧内所有（已保存剧本的）分集依次跑完整流水线
   * （拆解→素材→分镜→视频→配音→合成分集成片），整剧进度通过整剧级 SSE
   * （/dramas/:id/logs/stream）广播，前端可在成片进度页实时看到走哪一步。
   */
  async generateDrama(dramaId: number) {
    if (this.dramaRunning.has(dramaId)) {
      throw new ForbiddenException('该项目已有整剧成片任务进行中，请稍候');
    }
    const drama = await this.prisma.drama.findFirst({
      where: { id: dramaId, deletedAt: null },
      include: {
        episodes: {
          where: { deletedAt: null },
          orderBy: { episodeNumber: 'asc' },
        },
      },
    });
    if (!drama) throw new NotFoundException(`项目 ${dramaId} 不存在`);

    this.dramaRunning.add(dramaId);
    void Promise.resolve()
      .then(() => this.runDramaPipeline(drama))
      .catch((e: any) => {
        this.logBus.emitDrama(dramaId, {
          type: 'error',
          data: { text: e?.message || '整剧成片失败' },
        });
      })
      .finally(() => {
        this.dramaRunning.delete(dramaId);
        this.logBus.emitDrama(dramaId, {
          type: 'done',
          data: { scope: 'drama', finished: true },
        });
      });

    const eps = drama.episodes.map((e) => e.id);
    this.log(
      eps[0] ?? dramaId,
      'info',
      `🎬 整剧一键成片已发起：共 ${episodeListLabel(drama.episodes)}`,
    );
    return { started: true, dramaId, episodes: eps };
  }

  /** 后台整剧流水线主体 */
  private async runDramaPipeline(drama: any) {
    const dramaId = drama.id;
    const eps = drama.episodes.filter((e: any) => (e.scriptText || '').trim());
    const live = this.factory.isLive('text');
    if (eps.length === 0) {
      this.logBus.emitDrama(dramaId, {
        type: 'error',
        data: { text: '没有任何分集保存了剧本原文，无法整剧成片，请先在各分集「剧本」面板粘贴并保存剧本' },
      });
      return;
    }
    this.phased(
      dramaId,
      { scope: 'drama', stepId: 'start', stepLabel: '开始整剧成片', percent: 0 },
      0,
    );

    let done = 0;
    const total = eps.length;
    for (const ep of eps) {
      const base = Math.round((done / total) * 100);
      this.phased(
        dramaId,
        {
          scope: 'drama',
          episodeId: ep.id,
          episodeTitle: ep.title,
          stepId: `episode-${ep.episodeNumber}`,
          stepLabel: `第 ${ep.episodeNumber} 集「${ep.title}」`,
          percent: base,
        },
        ep.id,
      );
      try {
        await this.runEpisode(ep.id, dramaId, {
          steps: {
            characters: true,
            scenes: true,
            props: true,
            storyboardImages: true,
            storyboardVideos: true,
            merge: true,
          },
        });
      } catch (e: any) {
        this.log(ep.id, 'error', `第 ${ep.episodeNumber} 集成片失败：${e?.message ?? e}`);
        this.logBus.emitDrama(dramaId, {
          type: 'error',
          data: { text: `第 ${ep.episodeNumber} 集成片失败：${e?.message ?? e}` },
        });
      }
      done += 1;
    }

    if (!live) {
      this.logBus.emitDrama(dramaId, {
        type: 'log',
        data: { level: 'warn', text: '未配置文本模型（AGNES_API_KEY），已跳过剧本自动拆解（分镜为空的集数未生成内容）', at: new Date().toISOString() },
      });
    }
    this.phased(
      dramaId,
      { scope: 'drama', stepId: 'finish', stepLabel: '全部集数已成片', percent: 100 },
      0,
    );
    this.logBus.emitDrama(dramaId, {
      type: 'merge',
      data: { progress: 100 },
    });
  }

  /** 广播流水线阶段事件（整剧级通道；若带 episodeId 同时广播到分集通道） */
  private phased(
    dramaId: number,
    data: any,
    episodeId?: number | null,
  ) {
    const ev = { type: 'phase' as const, data };
    if (episodeId) this.logBus.emit(episodeId, ev);
    this.logBus.emitDrama(dramaId, ev);
  }

  /**
   * 保证分镜存在：分镜为空时——若 reset 的自动拆解还在跑则等待其完成；
   * 否则若剧本原文可拆解则在此直接触发一次拆解（让「重置后一键成片」无需手动进详情）。
   */
  private async ensureStoryboards(episodeId: number) {
    for (let i = 0; i < 180; i++) {
      const cnt = await this.prisma.storyboard.count({
        where: { episodeId, deletedAt: null },
      });
      if (cnt > 0) return;
      if (this.parseRunning.has(episodeId)) {
        await sleep(1500); // reset 触发的自动拆解进行中，等待其落库
        continue;
      }
      break;
    }
    const ep = await this.prisma.episode.findFirst({
      where: { id: episodeId, deletedAt: null },
      include: { drama: true },
    });
    if (!ep || !(ep.scriptText || '').trim()) return;
    if (!this.factory.isLive('text')) {
      this.log(episodeId, 'warn', '未配置文本模型（AGNES_API_KEY），分镜为空时无法自动拆解');
      return;
    }
    this.log(episodeId, 'info', '📖 检测到暂无分镜，先自动拆解剧本再继续流水线...');
    try {
      const parsed = await this.requestParseScript(ep);
      await this.applyParsed(ep, 'replace', parsed);
    } catch (e: any) {
      this.log(episodeId, 'error', `自动拆解剧本失败：${e?.message ?? e}`);
    }
  }

  /**
   * 一键成剧集：按勾选步骤依次执行。
   * 缺省 = 素材四步（①角色 → ②场景 → ③道具 → ④分镜首尾帧），
   * 可扩展 ⑤分镜视频 / ⑥合成成片，形成完整流水线。
   */
  private async runEpisode(
    episodeId: number,
    dramaId: number,
    opts: GenerateEpisodeOpts = {},
  ) {
    const steps = {
      characters: opts.steps?.characters !== false,
      scenes: opts.steps?.scenes !== false,
      props: opts.steps?.props !== false,
      storyboardImages: opts.steps?.storyboardImages !== false,
      storyboardVideos: opts.steps?.storyboardVideos === true,
      merge: opts.steps?.merge === true,
    };
    const style = await this.resolveGenCfgOfEpisode(episodeId);
    const stepNames = [
      steps.characters && '①角色',
      steps.scenes && '②场景',
      steps.props && '③道具',
      steps.storyboardImages && '④分镜首尾帧',
      steps.storyboardVideos && '⑤分镜视频',
      steps.merge && '⑥合成成片',
    ]
      .filter(Boolean)
      .join(' → ');
    try {
      if (this.rate.isCircuitOpen()) {
        this.log(episodeId, 'error', `生成已熔断：${this.rate.circuitMessage()}`);
        return;
      }

      // 0️⃣ 前置：分镜为空时自动拆解（或等待 reset 触发的自动拆解完成），让「重置后一键成片」无感衔接
      await this.ensureStoryboards(episodeId);
      const hasSB = (await this.prisma.storyboard.count({ where: { episodeId, deletedAt: null } })) > 0;
      if (!hasSB && (steps.storyboardImages || steps.storyboardVideos || steps.merge)) {
        this.log(episodeId, 'warn', '分镜为空，跳过分镜相关步骤（请在「剧本」面板保存剧本原文后再试）');
      }

      this.log(episodeId, 'info', `🚀 一键生成开始：${stepNames}`);

      // ⏹ 阶段控制：阶段内并发执行，阶段间严格串行；只补缺素的项，其中任一失败即整体
      // 暂停、不再进入下一阶段，保证「角色→场景→道具→分镜→视频」的前置完整性（如某个
      // 角色没生成，场景/道具/分镜/视频一律不做）。
      const failOf = <T>(items: T[], label: (t: T) => string, fn: (t: T) => Promise<void>) =>
        Promise.allSettled(
          items.map(async (it) => {
            try {
              await fn(it);
              return null;
            } catch (e: any) {
              return { name: label(it), msg: e?.message ?? String(e) };
            }
          }),
        ).then((r) =>
          r
            .filter((x) => x.status === 'fulfilled' && (x as any).value)
            .map((x) => (x as any).value as { name: string; msg: string }),
        );
      const pauseIfFailed = (
        stepLabel: string,
        needed: number,
        failed: { name: string; msg: string }[],
      ) => {
        if (failed.length === 0) return true;
        this.log(
          episodeId,
          'error',
          `⏹ ${stepLabel}共 ${needed} 项，其中 ${failed.length} 项生成失败，流水线已暂停（后续素材不会生成），请先解决再重试`,
        );
        for (const f of failed) this.log(episodeId, 'error', `   ✗ ${f.name}：${f.msg}`);
        return false;
      };

      // ① 角色（整剧共享，只补缺图；并发生成，全部成功才进入下一步）
      this.phased(dramaId, { scope: 'episode', stepId: 'characters', stepLabel: '① 角色形象' }, episodeId);
      if (steps.characters) {
        const characters = await this.prisma.character.findMany({
          where: { dramaId, deletedAt: null },
        });
        const styleTag = anchorStyleTag(style);
        const toGen = characters.filter(
          (c) => !(c.imageUrl && (c.anchors || '').includes(styleTag)),
        );
        this.log(episodeId, 'info', `① 角色共 ${characters.length} 个，需生成 ${toGen.length} 个（并行）`);
        const failed = await failOf(toGen, (c) => `角色「${c.name}」`, (c) =>
          this.runCharacter(c, episodeId, style),
        );
        if (!pauseIfFailed('① 角色', toGen.length, failed)) return;
      }

      // ② 场景
      this.phased(dramaId, { scope: 'episode', stepId: 'scenes', stepLabel: '② 场景' }, episodeId);
      if (steps.scenes) {
        const scenes = await this.prisma.scene.findMany({
          where: { episodeId, deletedAt: null },
          include: { episode: true },
        });
        const toGen = scenes.filter((s) => !s.imageUrl);
        this.log(episodeId, 'info', `② 场景共 ${scenes.length} 个，需生成 ${toGen.length} 个（并行）`);
        const failed = await failOf(toGen, (s) => `场景「${s.location}」`, (s) =>
          this.runScene(s, {}, style),
        );
        if (!pauseIfFailed('② 场景', toGen.length, failed)) return;
      }

      // ③ 道具
      this.phased(dramaId, { scope: 'episode', stepId: 'props', stepLabel: '③ 道具' }, episodeId);
      if (steps.props) {
        const props = await this.prisma.prop.findMany({
          where: { episodeId, deletedAt: null },
          include: { episode: true },
        });
        const toGen = props.filter((p) => !p.imageUrl);
        this.log(episodeId, 'info', `③ 道具共 ${props.length} 个，需生成 ${toGen.length} 个（并行）`);
        const failed = await failOf(toGen, (p) => `道具「${p.name}」`, (p) =>
          this.runProp(p, {}, style),
        );
        if (!pauseIfFailed('③ 道具', toGen.length, failed)) return;
      }

      // ④ 分镜首尾帧 + ⑤ 分镜视频
      const list = await this.prisma.storyboard.findMany({
        where: { episodeId, deletedAt: null },
        orderBy: { number: 'asc' },
        select: { id: true, number: true },
      });
      if (!steps.storyboardImages && !steps.storyboardVideos) {
        /* 未勾选分镜相关，跳过 */
      } else if (list.length === 0) {
        this.log(episodeId, 'warn', '暂无分镜，先添加分镜后再生成');
      } else {
        // ④ 分镜首尾帧（并发生成；要出视频则本阶段必须全部成功）
        if (steps.storyboardImages) {
          this.phased(dramaId, { scope: 'episode', stepId: 'storyboards', stepLabel: '④ 分镜首尾帧' }, episodeId);
          this.log(episodeId, 'info', `④ 分镜 ${list.length} 个，并行生成首帧+尾帧参考图`);
          const failed = await failOf(list, (it) => `分镜#${it.number}`, async (item) => {
            this.status(episodeId, item.id, 'generating', 10);
            const sb = await this.loadStoryboard(item.id);
            await this.runStoryboardImage(sb, {}, style);
            this.status(episodeId, item.id, 'pending', 60);
          });
          if (!pauseIfFailed('④ 分镜首尾帧', list.length, failed)) return;
        }

        // ⑤ 分镜视频（仅补缺失；失败即停，避免成片缺镜头）
        if (steps.storyboardVideos) {
          this.phased(dramaId, { scope: 'episode', stepId: 'storyboardVideos', stepLabel: '⑤ 分镜视频' }, episodeId);
          const toVideo: { id: number; number: number }[] = [];
          for (const item of list) {
            const sb = await this.loadStoryboard(item.id);
            if (!sb.videoUrl) toVideo.push(item);
          }
          this.log(episodeId, 'info', `⑤ 分镜视频共 ${list.length} 个，需生成 ${toVideo.length} 个（并行）`);
          const failed = await failOf(toVideo, (it) => `分镜#${it.number}`, async (item) => {
            this.status(episodeId, item.id, 'generating', 70);
            const sb = await this.loadStoryboard(item.id);
            await this.runStoryboardVideoFlow(sb, {}, style);
            this.status(episodeId, item.id, 'pending', 90);
          });
          if (!pauseIfFailed('⑤ 分镜视频', toVideo.length, failed)) return;
        }
      }

      await this.prisma.episode.update({
        where: { id: episodeId },
        data: { status: 'editing' },
      });
      this.log(
        episodeId,
        'success',
        `🎉 一键生成完成：${stepNames}${steps.merge ? '' : '（如需视频/合成，可在生成选项或分镜面板继续）'}`,
      );

      // ⑦ 合成成片（放在最后，等视频/配音就绪）
      if (steps.merge) {
        this.phased(dramaId, { scope: 'episode', stepId: 'merge', stepLabel: '⑥ 合成成片' }, episodeId);
        const sbs = await this.prisma.storyboard.findMany({
          where: { episodeId, deletedAt: null },
          orderBy: { number: 'asc' },
          select: {
            id: true,
            number: true,
            videoUrl: true,
            sourceUrl: true,
            audioUrl: true,
            narration: true,
            duration: true,
            imageUrl: true,
          },
        });
        const episode = await this.prisma.episode.findFirst({
          where: { id: episodeId, deletedAt: null },
        });
        if (sbs.length > 0 && episode) {
          const mergeCfg = this.parseMergeCfg(episode.mergeCfg);
          await this.runMerge(episode, mergeCfg, sbs);
        }
      }
    } finally {
      this.running.delete(episodeId);
    }
  }

  /**
   * 一键重新生成分镜素材：根据当前剧本，强制重做全部首尾帧 → 分镜视频 → 配音。
   * 用于剧本修改后整体重出，保证人物风格 / 音轨语言 / 唱词全剧一致。
   */
  async regenerateStoryboards(episodeId: number) {
    if (this.running.get(episodeId)) {
      throw new ForbiddenException('该分集已有生成任务进行中');
    }
    const episode = await this.prisma.episode.findFirst({
      where: { id: episodeId, deletedAt: null },
      include: { drama: true },
    });
    if (!episode) throw new NotFoundException(`分集 ${episodeId} 不存在`);
    const list = await this.prisma.storyboard.findMany({
      where: { episodeId, deletedAt: null },
      orderBy: { number: 'asc' },
      select: { id: true, number: true },
    });
    if (list.length === 0) {
      throw new ForbiddenException('暂无分镜，请先添加分镜');
    }
    this.running.set(episodeId, true);
    this.fire(episodeId, 'episode', () =>
      this.runRegenerateStoryboards(episodeId, list),
    );
    return { started: true, episodeId, count: list.length };
  }

  private async runRegenerateStoryboards(
    episodeId: number,
    list: Array<{ id: number; number: number }>,
  ) {
    try {
      const style = await this.resolveGenCfgOfEpisode(episodeId);
      this.log(
        episodeId,
        'info',
        `🔄 一键重新生成分镜素材：${list.length} 个分镜（首尾帧 → 视频 → 配音），按当前剧本重出`,
      );
      for (const item of list) {
        try {
          this.status(episodeId, item.id, 'generating', 5);
          const sb = await this.loadStoryboard(item.id);
          await this.runStoryboardImage(sb, { force: true }, style);
          const afterImage = await this.loadStoryboard(item.id);
          await this.runVideo(afterImage, style, true);
          this.status(episodeId, item.id, 'finished', 100);
        } catch (e: any) {
          this.status(episodeId, item.id, 'cancelled', 0);
          this.log(episodeId, 'error', `[分镜#${item.number}] 重新生成失败：${e.message}`);
        }
      }
      this.log(episodeId, 'success', '🎉 分镜素材重新生成完成，人物风格 / 音轨语言 / 唱词已统一');
    } finally {
      this.running.delete(episodeId);
    }
  }

  // ==================== ⑤ 合成视频 ====================
  async merge(episodeId: number, cfg: any) {
    const episode = await this.prisma.episode.findFirst({
      where: { id: episodeId, deletedAt: null },
    });
    if (!episode) throw new NotFoundException(`分集 ${episodeId} 不存在`);

    const sbs = await this.prisma.storyboard.findMany({
      where: { episodeId, deletedAt: null },
      orderBy: { number: 'asc' },
      select: {
        id: true,
        number: true,
        videoUrl: true,
        sourceUrl: true,
        audioUrl: true,
        narration: true,
        duration: true,
        imageUrl: true,
      },
    });
    if (sbs.length === 0) {
      throw new ForbiddenException('无可合成的分镜，先完成分镜生成');
    }

    const mergeCfg = this.parseMergeCfg(episode.mergeCfg, cfg);
    await this.prisma.episode.update({
      where: { id: episodeId },
      data: { mergeCfg: JSON.stringify(mergeCfg) },
    });

    this.fire(episodeId, 'episode', () => this.runMerge(episode, mergeCfg, sbs));
    return { ok: true, task: 'merge', episodeId };
  }

  /** 合并合成配置：默认值 + 已存配置 + 本次覆盖 */
  private parseMergeCfg(saved?: string | null, override: any = {}) {
    let base: any = {};
    if (saved) {
      try {
        base = JSON.parse(saved);
      } catch {
        /* ignore */
      }
    }
    return {
      burn_dialogue_audio: true,
      burn_narration_subtitles: true,
      keep_original_audio: false,
      aspect_ratio: '9:16',
      frame_rate: 30,
      resolution: '1080p',
      // AI 视频偶发像素被旋转 90°，开启后自动抽首帧与参考图对比校正
      auto_correct_rotation: true,
      ...base,
      ...(override ?? {}),
    };
  }

  // ==================== 重置（物理删除生成素材，保留文本） ====================
  /**
   * 重置单个分集 = 清空重来：物理删除本集全部生成文件，硬删本集的分镜 / 场景 /
   * 道具记录，并删除「本集之外再无任何分镜引用」的本集角色，最后若已配置剧本与人
   * 工智能则自动按剧本原文重新拆解生成角色 / 场景 / 道具 / 分镜文本（后台执行 + SSE）。
   */
  async resetEpisode(episodeId: number) {
    if (this.running.get(episodeId) || this.parseRunning.has(episodeId)) {
      throw new ForbiddenException('该分集已有生成/拆解任务进行中，请稍候再重置');
    }
    const episode = await this.prisma.episode.findFirst({
      where: { id: episodeId, deletedAt: null },
      include: { drama: true },
    });
    if (!episode) throw new NotFoundException(`分集 ${episodeId} 不存在`);
    const dramaId = episode.dramaId;

    // ① 物理删除本集全部生成文件（不可逆）
    await this.storage.removeEpisodeDir(dramaId, episodeId);

    // ② 收集本集分镜引用的角色，随后硬删本集分镜 / 场景 / 道具
    const sbChars = await this.prisma.storyboard.findMany({
      where: {
        episodeId,
        OR: [{ characterId: { not: null } }, { characterIds: { not: null } }],
      },
      select: { characterId: true, characterIds: true },
    });
    const usedCharIds = new Set<number>();
    for (const r of sbChars) {
      if (r.characterId != null) usedCharIds.add(r.characterId);
      for (const cid of this.parseIds(r.characterIds, null)) usedCharIds.add(cid);
    }
    const [sb, sc, pr] = await this.prisma.$transaction([
      this.prisma.storyboard.deleteMany({ where: { episodeId } }),
      this.prisma.scene.deleteMany({ where: { episodeId } }),
      this.prisma.prop.deleteMany({ where: { episodeId } }),
    ]);

    // ③ 删除「重置后全剧再无任何分镜引用」的角色（仍被其他分集引用则保留）
    let chDeleted = 0;
    for (const cid of usedCharIds) {
      // 检查其他分集是否仍引用该角色（单值 characterId 或多选 characterIds）
      const remainSingle = await this.prisma.storyboard.count({
        where: {
          characterId: cid,
          episodeId: { not: episodeId },
          deletedAt: null,
        },
      });
      const remainMulti = await this.prisma.storyboard.count({
        where: {
          episodeId: { not: episodeId },
          deletedAt: null,
          characterIds: { not: null },
        },
      });
      let remain = remainSingle;
      if (remain === 0 && remainMulti > 0) {
        // 逐条检查其他分集的 characterIds 是否含 cid
        const rows = await this.prisma.storyboard.findMany({
          where: { episodeId: { not: episodeId }, deletedAt: null, characterIds: { not: null } },
          select: { characterIds: true },
        });
        remain = rows.some((r) => this.parseIds(r.characterIds, null).includes(cid)) ? 1 : 0;
      }
      if (remain > 0) continue;
      const ch = await this.prisma.character.findFirst({
        where: { id: cid, deletedAt: null },
      });
      if (!ch) continue;
      for (const u of [ch.imageUrl, ch.sourceUrl]) {
        const abs = this.storage.absFromUrl(u);
        if (abs && fs.existsSync(abs)) {
          try {
            await fs.promises.unlink(abs);
          } catch {
            /* 文件清理失败不阻塞主流程 */
          }
        }
      }
      await this.prisma.character.deleteMany({ where: { id: cid } });
      chDeleted += 1;
    }

    // ④ 重置分集合成状态
    await this.prisma.episode.update({
      where: { id: episodeId },
      data: { merged: false, mergedUrl: null, mergeCfg: null, status: 'draft' },
    });

    this.log(
      episodeId,
      'success',
      `🧹 分集「${episode.title}」数据已清空：删除分镜 ${sb.count}、场景 ${sc.count}、道具 ${pr.count}、不再被引用的角色 ${chDeleted}，生成素材已物理删除`,
    );

    // ⑤ 自动按剧本原文重新拆解生成（后台执行 + SSE 日志）
    let autoParse = false;
    if (!(episode.scriptText || '').trim()) {
      this.log(
        episodeId,
        'warn',
        '本集未保存剧本原文，跳过自动重建；请在「剧本」面板粘贴并保存剧本后，再手动操作 AI 拆解',
      );
    } else if (!this.factory.isLive('text')) {
      this.log(
        episodeId,
        'warn',
        '未配置文本模型（AGNES_API_KEY），跳过自动重建，请配置后重新生成',
      );
    } else {
      autoParse = true;
      this.log(
        episodeId,
        'info',
        '🤖 正在按剧本原文自动重建角色 / 场景 / 道具 / 分镜，进度见下方日志...',
      );
      this.fire(episodeId, 'episode', async () => {
        const parsed = await this.requestParseScript(episode);
        await this.applyParsed(episode, 'replace', parsed);
      });
    }

    return {
      ok: true,
      episodeId,
      started: autoParse,
      deleted: { storyboards: sb.count, scenes: sc.count, props: pr.count, characters: chDeleted },
    };
  }

  /**
   * 重置整部剧 = 清空重来：物理删除整剧全部素材，硬删所有分集的分镜 / 场景 / 道具
   * 记录以及全部角色记录，然后对每个保存了剧本原文的分集自动按剧本原文重新拆解生成
   * 角色 / 场景 / 道具 / 分镜文本（后台执行 + SSE）。
   */
  async resetDrama(dramaId: number) {
    const drama = await this.prisma.drama.findFirst({
      where: { id: dramaId, deletedAt: null },
      include: { episodes: { where: { deletedAt: null } } },
    });
    if (!drama) throw new NotFoundException(`项目 ${dramaId} 不存在`);
    const epIds = drama.episodes.map((e) => e.id);

    // ① 物理删除整剧素材目录（含剧集级共享目录 0，不可逆）
    await this.storage.removeDramaDir(dramaId);

    // ② 硬删除全部记录：先分镜（引用方）→ 场景/道具 → 角色
    const [sb, sc, pr, ch] = await this.prisma.$transaction([
      this.prisma.storyboard.deleteMany({ where: { episodeId: { in: epIds } } }),
      this.prisma.scene.deleteMany({ where: { episodeId: { in: epIds } } }),
      this.prisma.prop.deleteMany({ where: { episodeId: { in: epIds } } }),
      this.prisma.character.deleteMany({ where: { dramaId } }),
    ]);

    // ③ 重置所有分集状态
    if (epIds.length) {
      await this.prisma.episode.updateMany({
        where: { id: { in: epIds } },
        data: { merged: false, mergedUrl: null, mergeCfg: null, status: 'draft' },
      });
    }

    this.log(
      epIds[0] ?? 0,
      'success',
      `🧹 项目「${drama.title}」数据已清空：删除角色 ${ch.count}、分镜 ${sb.count}、场景 ${sc.count}、道具 ${pr.count}，素材目录已物理删除`,
    );

    // ④ 对每个保存了剧本的分集自动按剧本原文重新拆解生成（后台执行 + SSE）
    let startedCount = 0;
    const live = this.factory.isLive('text');
    for (const ep of drama.episodes) {
      if (!(ep.scriptText || '').trim()) {
        this.log(
          ep.id,
          'warn',
          `本集未保存剧本原文，跳过自动重建；请在「剧本」面板粘贴并保存剧本后再手动拆解`,
        );
        continue;
      }
      if (!live) break;
      startedCount += 1;
      this.log(
        ep.id,
        'info',
        '🤖 正在按剧本原文自动重建角色 / 场景 / 道具 / 分镜，进度见下方日志...',
      );
      const parseEp = {
        id: ep.id,
        title: ep.title,
        description: ep.description,
        scriptText: ep.scriptText,
        dramaId: ep.dramaId,
        drama: { id: drama.id, title: drama.title, dialect: drama.dialect },
      };
      this.fire(ep.id, 'episode', async () => {
        const parsed = await this.requestParseScript(parseEp);
        await this.applyParsed(parseEp, 'replace', parsed);
      });
    }
    if (epIds.length && !live) {
      this.log(
        epIds[0],
        'warn',
        '未配置文本模型（AGNES_API_KEY），跳过自动重建，请配置后重新生成',
      );
    }

    return {
      ok: true,
      dramaId,
      started: startedCount,
      deleted: {
        characters: ch.count,
        storyboards: sb.count,
        scenes: sc.count,
        props: pr.count,
      },
    };
  }

  // ==================== 剧本拆解（剧本原文 → 角色/场景/道具/分镜） ====================

  /** 剧本拆解任务锁（按分集） */
  private parseRunning = new Set<number>();
  /**
   * AI 拆解剧本：读取分集的 scriptText，由文本模型拆解出角色 / 场景 / 道具 / 分镜
   * 文本记录并落库（后台执行 + SSE 日志）。mode=replace 时先硬删除本集已有的
   * 分镜/场景/道具；角色为整剧共享，按姓名去重：同名复用并补全缺失字段。
   */
  async parseScript(
    episodeId: number,
    opts: { mode?: 'append' | 'replace' } = {},
  ) {
    const episode = await this.assertParseable(episodeId);
    const mode = opts.mode === 'replace' ? 'replace' : 'append';
    if (this.parseRunning.has(episodeId)) {
      throw new BadRequestException('本分集剧本拆解已在进行中，请稍候');
    }
    this.parseRunning.add(episodeId);
    this.fire(episodeId, 'episode', async () => {
      try {
        const parsed = await this.requestParseScript(episode);
        await this.applyParsed(episode, mode, parsed);
      } finally {
        this.parseRunning.delete(episodeId);
      }
    });
    return { started: true, episodeId, mode };
  }

  /** 预览：同步调 AI 拆解并返回规范化结果，不落库（前端确认后调 apply） */
  async previewParseScript(episodeId: number) {
    const episode = await this.assertParseable(episodeId);
    const parsed = await this.requestParseScript(episode);
    return {
      episodeId,
      parsed,
      counts: {
        characters: parsed.characters.length,
        scenes: parsed.scenes.length,
        props: parsed.props.length,
        storyboards: parsed.storyboards.length,
      },
    };
  }

  /** 应用：把预览确认过（或前端编辑过）的拆解结果落库（后台执行 + SSE 日志） */
  async applyParsedScript(
    episodeId: number,
    body: { mode?: 'append' | 'replace'; parsed?: any } = {},
  ) {
    const episode = await this.prisma.episode.findFirst({
      where: { id: episodeId, deletedAt: null },
      include: { drama: true },
    });
    if (!episode) throw new NotFoundException(`分集 ${episodeId} 不存在`);
    const mode = body?.mode === 'replace' ? 'replace' : 'append';
    const parsed = normalizeParsedScript(body?.parsed);
    if (!parsed.storyboards.length) {
      throw new BadRequestException('拆解结果中没有任何分镜，无法落库');
    }
    if (this.parseRunning.has(episodeId)) {
      throw new BadRequestException('本分集剧本拆解已在进行中，请稍候');
    }
    this.parseRunning.add(episodeId);
    this.fire(episodeId, 'episode', async () => {
      try {
        await this.applyParsed(episode, mode, parsed);
      } finally {
        this.parseRunning.delete(episodeId);
      }
    });
    return { started: true, episodeId, mode };
  }

  /** 拆解前置校验：分集存在、剧本原文已保存、文本模型可用 */
  private async assertParseable(episodeId: number) {
    const episode = await this.prisma.episode.findFirst({
      where: { id: episodeId, deletedAt: null },
      include: { drama: true },
    });
    if (!episode) throw new NotFoundException(`分集 ${episodeId} 不存在`);
    if (!(episode.scriptText || '').trim()) {
      throw new BadRequestException(
        '本分集尚未保存剧本原文，请先在「剧本」面板中粘贴剧本并保存',
      );
    }
    if (!this.factory.isLive('text')) {
      throw new BadRequestException(
        '未配置文本模型（AGNES_API_KEY），无法使用 AI 拆解剧本',
      );
    }
    return episode;
  }

  /** 调文本模型拆解剧本，返回规范化结构（不落库） */
  private async requestParseScript(episode: {
    id: number;
    title: string;
    description: string | null;
    scriptText: string | null;
    dramaId: number;
    drama: { id: number; title: string; dialect: string | null };
  }): Promise<ParsedScript> {
    const script = (episode.scriptText || '').trim();
    const chunks = splitScriptChunks(script);
    if (chunks.length > 1) {
      this.log(
        episode.id,
        'info',
        `📚 剧本较长（${script.length} 字），已自动切分为 ${chunks.length} 段分批拆解，避免模型输出被截断`,
      );
    }
    this.log(
      episode.id,
      'info',
      `🤖 正在调用文本模型拆解剧本，请稍候（约 10~60 秒${chunks.length > 1 ? ' × ' + chunks.length + ' 段' : ''}）...`,
    );
    const parts: ParsedScript[] = [];
    for (let i = 0; i < chunks.length; i += 1) {
      if (chunks.length > 1) {
        this.log(episode.id, 'info', `🤖 正在拆解第 ${i + 1}/${chunks.length} 段剧本...`);
      }
      parts.push(
        await this.requestParseScriptChunk(episode, chunks[i], i + 1, chunks.length),
      );
    }
    return mergeParsed(parts);
  }

  /** 单段剧本 → 文本模型 → 规范化结构 */
  private async requestParseScriptChunk(
    episode: {
      id: number;
      title: string;
      description: string | null;
      dramaId: number;
      drama: { id: number; title: string; dialect: string | null };
    },
    scriptChunk: string,
    chunkIndex: number,
    chunkTotal: number,
  ): Promise<ParsedScript> {
    const prompt = [
      '你是资深短剧分镜师。请阅读下面的漫剧剧本，把它拆解为可直接投产的结构化数据。',
      '',
      '项目信息：',
      `剧名：${episode.drama.title}`,
      episode.drama.dialect ? `剧集方言：${episode.drama.dialect}` : '',
      `分集标题：${episode.title}`,
      episode.description ? `分集简介：${episode.description}` : '',
      chunkTotal > 1
        ? `注意：这是完整剧本的第 ${chunkIndex}/${chunkTotal} 段，只拆解本段内容，不要补写前后段落的情节。`
        : '',
      '',
      '输出要求（务必遵守）：',
      '1. 只输出一个 JSON 对象，不要任何解释、Markdown 代码块标记或多余文字。',
      '2. JSON 结构如下：',
      '{"characters":[{"name":"角色名","role":"main|supporting|minor","roleLabel":"一句话身份标签","appearance":"外貌描述80~150字：发型发色、五官、体型、标志性特征、整体气质","intro":"角色简介100字内"}],',
      ' "scenes":[{"location":"场景地点","time":"时间段如白天/夜晚，可为空字符串","description":"场景描述80~150字"}],',
      ' "props":[{"name":"道具名","type":"道具类型","description":"道具描述50~100字"}],',
      ' "storyboards":[{"characters":["角色名","角色名"],"scene":"场景地点，须与scenes中location一致","prop":"道具名，无则空字符串","dialogue":"本镜对白1~3句，可空","narration":"旁白1~2句，可空","sceneDescription":"画面描述：内容/景别/构图/机位，1~3句","motionDescription":"动作与运镜描述，1~3句","emotion":"neutral|happy|sad|angry|fear|surprise","duration":5}]}',
      '3. 分镜须完整覆盖剧本情节并按叙事顺序排列；每镜时长为 4~12 的整数秒。',
      '4. 每个分镜的 characters 必须列出「本镜画面中出现」的全部角色（说话者与同框在场的角色都要列出，按主次排序），只能填上方 characters 列表中的角色名，禁止填入兵马俑、群众、雕像、动物等非角色实体。判定规则：①双人对话场景默认两个角色同框（说话者为第一主体，另一角色作为听众/反应角色也必须列入）；②动作描述中被互动的对方必须列入（如「老爸拉住蛋蛋」中老爸和蛋蛋都在画面里，两个都要列出）；③除非剧本明确写了切换到单人特写，否则同场景内先前在场且未离场的角色保持列入。对白直接写台词本身，不要带「角色名：」前缀；对白只写本镜主要说话角色的台词，对方的回话放到下一镜（保持一镜一说话人，便于配音）。无角色（纯空镜/旁白镜）用空数组 []。',
      '5. 角色只收录有台词或关键动作的角色；场景、道具只收录需要出图的关键项，不要凑数。',
      '6. 角色跨镜头必须可辨认：appearance 里必须写明服装的颜色与款式（如「蓝色马甲、白衬衫」）与标志性配饰，这些是角色在全剧的身份标识，不得省略。同名同地点的条目只输出一条。',
      '7. sceneDescription 必须写清景别（远景/全景/中景/近景/特写）与机位角度（平视/俯拍/仰拍），不要只写情绪；motionDescription 必须是具体可见的动作或镜头运动（如「镜头缓慢推近」「角色转身走向门口」），不要写「气氛紧张」这类不可拍摄的抽象描述。',
      '8. 相邻分镜不要用完全相同的景别与构图，按「远—中—近」交替推进，保证节奏与画面变化。',
      '',
      '剧本原文：',
      scriptChunk,
    ]
      .filter((l) => l !== '')
      .join('\n');

    const provider = this.factory.resolve('text');
    const res = await provider.generate('text', {
      prompt,
      options: { temperature: 0.4, maxTokens: 8000 },
    });
    return normalizeParsedScript(extractJsonObject(res.text || ''));
  }
  /** 落库：替换清空（可选）→ 角色按姓名去重复用 → 场景/道具 → 分镜 */
  private async applyParsed(
    episode: {
      id: number;
      title: string;
      description: string | null;
      scriptText: string | null;
      dramaId: number;
      drama: { id: number; title: string; dialect: string | null };
    },
    mode: 'append' | 'replace',
    parsed: ParsedScript,
  ) {
    const episodeId = episode.id;
    this.log(
      episodeId,
      'info',
      `📖 开始落库拆解结果（${mode === 'replace' ? '替换模式：先清空本集已有分镜/场景/道具' : '追加模式'}）...`,
    );

    // ① 替换模式：先物理清空本集素材目录（旧分镜/场景/道具的生成文件、
    // 成片与临时文件；角色素材在剧集级目录 {dramaId}/0/ 不受影响），
    // 再硬删除本集分镜 / 场景 / 道具记录，避免孤儿文件堆积
    if (mode === 'replace') {
      await this.storage.removeEpisodeDir(episode.dramaId, episodeId);
      await this.prisma.episode.update({
        where: { id: episodeId },
        data: { merged: false, mergedUrl: null, mergeCfg: null, status: 'draft' },
      });
      const [sb, sc, pr] = await this.prisma.$transaction([
        this.prisma.storyboard.deleteMany({ where: { episodeId } }),
        this.prisma.scene.deleteMany({ where: { episodeId } }),
        this.prisma.prop.deleteMany({ where: { episodeId } }),
      ]);
      this.log(
        episodeId,
        'info',
        `🗑️ 已清空本集旧数据：分镜 ${sb.count} 条、场景 ${sc.count} 条、道具 ${pr.count} 条，生成素材已物理删除`,
      );
    }

    const { characters, scenes, props, storyboards } = parsed;
    if (!storyboards.length) {
      throw new Error('拆解结果中没有任何分镜');
    }

    // ③ 角色：按姓名去重（整剧共享，同名复用并补全缺失字段）
    const existChars = await this.prisma.character.findMany({
      where: { dramaId: episode.dramaId, deletedAt: null },
    });
    const charMap = new Map<string, number>();
    for (const c of existChars) charMap.set(c.name.trim(), c.id);
    // 角色名单变了，场景/道具提示词里用于「人名 vs 实物」消歧的上下文缓存必须失效
    this.roleCtxCache.delete(episode.dramaId);
    let charCreated = 0;
    const appearanceChanged: string[] = [];
    for (const c of characters) {
      const name = normStr(c?.name);
      if (!name) continue;
      const existId = charMap.get(name);
      if (existId) {
        const patch: any = {};
        const roleLabel = normStr(c?.roleLabel);
        const appearance = normStr(c?.appearance);
        const intro = normStr(c?.intro);
        if (roleLabel) patch.roleLabel = roleLabel;
        if (appearance) patch.appearance = appearance;
        if (intro) patch.intro = intro;
        if (Object.keys(patch).length) {
          await this.prisma.character.update({
            where: { id: existId },
            data: patch,
          });
        }
        // 已出立绘的角色：文字外貌变了不会自动改图。
        // 视觉锚点锚定的是「立绘实际形象」，若强行用新文字覆盖，
        // 会造成「立绘是旧形象、锚点写新外貌」的分裂，比不改更糟。
        // 这里只如实提示，让用户决定是否重出立绘。
        const old = existChars.find((x) => x.id === existId);
        if (
          appearance &&
          old?.appearance &&
          normalizeNameKey(appearance) !== normalizeNameKey(old.appearance) &&
          old?.imageUrl
        ) {
          appearanceChanged.push(name);
        }
        continue;
      }
      const created = await this.prisma.character.create({
        data: {
          dramaId: episode.dramaId,
          name,
          role: normStr(c?.role) || 'supporting',
          roleLabel: normStr(c?.roleLabel),
          appearance: normStr(c?.appearance),
          intro: normStr(c?.intro),
        },
      });
      charMap.set(name, created.id);
      charCreated += 1;
    }
    this.log(
      episodeId,
      'success',
      `👤 角色就绪：新增 ${charCreated} 名，复用已有 ${characters.length - charCreated} 名`,
    );
    if (appearanceChanged.length > 0) {
      this.log(
        episodeId,
        'warn',
        `⚠️ 以下角色的外貌文字已更新，但立绘图仍是旧形象：${appearanceChanged.join('、')}。` +
          `视觉锚点以立绘为准，需在「角色」面板手动重出立绘后才能让新外貌生效`,
      );
    }

    // ④ 场景 / 道具：同一「地点 + 时间段」只建一条，避免同一地点重复出图、
    // 也避免分镜引用到两个「看起来一样但 id 不同」的场景记录。
    // append 模式下先载入本集已有记录并复用，防止重复追加。
    const existScenes =
      mode === 'append'
        ? await this.prisma.scene.findMany({ where: { episodeId, deletedAt: null } })
        : [];
    const sceneByLocTime = new Map<string, number>();
    for (const s of existScenes) {
      sceneByLocTime.set(locTimeKey(s.location, s.time), s.id);
    }
    // sceneMap 供分镜按名称查 id（模糊匹配），初始化为已有场景的 location → id
    const sceneMap = new Map<string, number>(
      existScenes.map((s) => [s.location.trim(), s.id] as const),
    );
    let sceneCreated = 0;
    for (const s of scenes) {
      const location = normStr(s?.location);
      if (!location) continue;
      const time = normStr(s?.time);
      const existingId = sceneByLocTime.get(locTimeKey(location, time));
      if (existingId != null) {
        sceneMap.set(location, existingId);
        continue;
      }
      const created = await this.prisma.scene.create({
        data: { episodeId, location, time, description: normStr(s?.description) },
      });
      sceneByLocTime.set(locTimeKey(location, time), created.id);
      sceneMap.set(location, created.id);
      sceneCreated += 1;
    }
    const existProps =
      mode === 'append'
        ? await this.prisma.prop.findMany({ where: { episodeId, deletedAt: null } })
        : [];
    const propMap = new Map<string, number>();
    for (const p of existProps) propMap.set(p.name.trim(), p.id);
    let propCreated = 0;
    for (const p of props) {
      const name = normStr(p?.name);
      if (!name) continue;
      if (matchName(propMap, name) != null) continue;
      const created = await this.prisma.prop.create({
        data: {
          episodeId,
          name,
          type: normStr(p?.type),
          description: normStr(p?.description),
        },
      });
      propMap.set(name, created.id);
      propCreated += 1;
    }
    this.log(
      episodeId,
      'success',
      `🏞️ 场景新增 ${sceneCreated} 个，🪑 道具新增 ${propCreated} 个`,
    );

    // ⑤ 分镜：按返回顺序编号落库，名称 → 外键；没匹配上的名称收集起来打警告
    const unknownChars = new Set<string>();
    const unknownScenes = new Set<string>();
    const unknownProps = new Set<string>();

    // append 模式必须从「已有分镜的最大编号 +1」继续，
    // 否则会与已有分镜撞号（两个 number 相同的分镜，排序与 prevTailFrame 全部错乱）。
    let numberCursor = 0;
    if (mode === 'append') {
      const maxRow = await this.prisma.storyboard.aggregate({
        where: { episodeId, deletedAt: null },
        _max: { number: true },
      });
      numberCursor = maxRow._max.number ?? 0;
    }

    let sbCreated = 0;
    for (let i = 0; i < storyboards.length; i += 1) {
      const sb = storyboards[i];
      const hasText =
        normStr(sb?.dialogue) ||
        normStr(sb?.narration) ||
        normStr(sb?.sceneDescription) ||
        normStr(sb?.motionDescription);
      if (!hasText) continue; // 全空的分镜直接丢弃

      // 角色名模糊匹配：AI 返回的名字常带空格/称谓后缀（「蛋蛋 」「小蛋蛋」），
      // 精确匹配失败会导致分镜挂不上角色 —— 这是「分镜很烂」最常见的一处空档。
      const sbCharNames: string[] = (sb?.characters || [])
        .map((n: any) => normStr(n))
        .filter((n: string | null): n is string => Boolean(n));
      const resolvedCharIds: number[] = [];
      for (const n of sbCharNames) {
        const hit = matchName(charMap, n);
        if (hit != null) {
          if (!resolvedCharIds.includes(hit)) resolvedCharIds.push(hit);
        } else {
          unknownChars.add(n);
        }
      }
      const sceneName = normStr(sb?.scene) ?? '';
      const propName = normStr(sb?.prop) ?? '';
      const sceneId = sceneName ? matchName(sceneMap, sceneName) : null;
      const propId = propName ? matchName(propMap, propName) : null;
      if (sceneName && sceneId == null) unknownScenes.add(sceneName);
      if (propName && propId == null) unknownProps.add(propName);

      const dialogue = normStr(sb?.dialogue);
      const narration = normStr(sb?.narration);
      await this.prisma.storyboard.create({
        data: {
          episodeId,
          number: numberCursor + sbCreated + 1,
          characterId: resolvedCharIds[0] ?? null,
          characterIds: resolvedCharIds.length > 0 ? JSON.stringify(resolvedCharIds) : null,
          sceneId,
          propId,
          dialogue,
          narration,
          sceneDescription: normStr(sb?.sceneDescription),
          motionDescription: normStr(sb?.motionDescription),
          emotion: normEmotion(sb?.emotion),
          duration: normDuration(sb?.duration, dialogue, narration),
          status: 'pending',
        },
      });
      sbCreated += 1;
    }
    if (unknownChars.size) {
      this.log(
        episodeId,
        'warn',
        `⚠️ 以下分镜角色名未匹配到角色记录（已置空，可在分镜里手动补挂或改名后重新拆解）：${[...unknownChars].join('、')}`,
      );
    }
    if (unknownScenes.size) {
      this.log(
        episodeId,
        'warn',
        `⚠️ 以下分镜场景名未匹配到场景记录（已置空，可手动补挂）：${[...unknownScenes].join('、')}`,
      );
    }
    if (unknownProps.size) {
      this.log(
        episodeId,
        'warn',
        `⚠️ 以下分镜道具名未匹配到道具记录（已置空，可手动补挂）：${[...unknownProps].join('、')}`,
      );
    }
    this.log(
      episodeId,
      'success',
      `🎬 剧本拆解完成：共生成 ${sbCreated} 个分镜。可在分镜列表逐镜检查后，去生成首尾帧/视频/配音`,
    );
  }


  private async runMerge(
    episode: { id: number; dramaId: number },
    cfg: any,
    sbs: Array<{
      id: number;
      number: number;
      videoUrl: string | null;
      sourceUrl: string | null;
      audioUrl: string | null;
      narration: string | null;
      duration: number | null;
      imageUrl: string | null;
    }>,
  ) {
    const episodeId = episode.id;
    const { dramaId } = episode;
    const [tw, th] = this.resolutionOf(cfg);
    const fps = Number(cfg.frame_rate) || 30;
    const autoCorrect = cfg.auto_correct_rotation !== false; // 默认 true

    if (!(await this.ffmpeg.isAvailable())) {
      this.log(episodeId, 'error', 'ffmpeg 不可用，无法合成成片（请安装 ffmpeg 并加入 PATH）');
      return;
    }
    this.log(
      episodeId,
      'info',
      `🎬 开始合成视频：共 ${sbs.length} 个分镜，目标 ${tw}x${th} @${fps}fps` +
        (autoCorrect ? '，已开启自动旋转校正' : '，未开启自动旋转校正'),
    );

    const dir = this.storage.workDir(dramaId, episodeId);
    const segs: string[] = [];
    const mergeTemps: string[] = []; // 旋转检测抽取的首帧临时图，合成完统一清理
    let done = 0;
    for (const sb of sbs) {
      const videoLocal = this.storage.absFromUrl(sb.videoUrl) || this.storage.absFromUrl(sb.sourceUrl);
      const progress = () => {
        done += 1;
        const p = Math.round((done / (sbs.length + 1)) * 96);
        this.sbEmit(episodeId, 'merge', { progress: p });
      };
      if (!videoLocal || !fs.existsSync(videoLocal)) {
        this.log(episodeId, 'warn', `第 ${sb.number} 镜缺少视频文件，已用静音垫片补位`);
        const pad = path.join(dir, `seg-${sb.number}-pad.mp4`);
        await this.ffmpeg.buildSilentClip(pad, 3, tw, th, fps, 'black');
        if (fs.existsSync(pad)) segs.push(pad);
        progress();
        continue;
      }

      // 旋转检测（best-effort）：抽视频首帧与首帧参考图（imageUrl）对比，让文本模型判断是否被旋转 90°
      let transpose: 1 | 2 | undefined;
      if (autoCorrect) {
        try {
          const refAbs = this.storage.absFromUrl(sb.imageUrl);
          if (refAbs && fs.existsSync(refAbs)) {
            const firstFrameAbs = path.join(dir, `seg-${sb.number}-firstframe.jpg`);
            const extracted = await this.ffmpeg.extractFirstFrame(videoLocal, firstFrameAbs);
            if (extracted) {
              mergeTemps.push(firstFrameAbs);
              const refUri = await this.storage.toDataUri(refAbs);
              const frameUri = await this.storage.toDataUri(firstFrameAbs);
              if (refUri && frameUri) {
                const rot = await this.prompt.detectRotation(refUri, frameUri);
                if (rot === 1 || rot === 2) {
                  transpose = rot;
                  this.log(
                    episodeId,
                    'info',
                    `第 ${sb.number} 镜检测到旋转${rot === 1 ? '顺时针' : '逆时针'} 90°，自动校正`,
                  );
                }
              }
            }
          }
        } catch (e: any) {
          this.log(episodeId, 'warn', `第 ${sb.number} 镜旋转检测失败，跳过：${e.message}`);
        }
      }

      // 对白音轨：mergeCfg.burn_dialogue_audio 关闭时保留 AI 视频原声（此前该开关完全无效）
      const audioLocal = cfg.burn_dialogue_audio === false
        ? undefined
        : this.storage.absFromUrl(sb.audioUrl);
      const seg = path.join(dir, `seg-${sb.number}.mp4`);
      const ok = await this.ffmpeg.normalizeSegment({
        video: videoLocal,
        audio: audioLocal ?? undefined,
        // 旁白音轨待 TTS provider 接入后注入；当前仅对白
        targetW: tw,
        targetH: th,
        fps,
        out: seg,
        transpose,
      });
      if (!ok) {
        this.log(episodeId, 'warn', `第 ${sb.number} 镜规整失败，用静音垫片补位`);
        const pad = path.join(dir, `seg-${sb.number}-pad.mp4`);
        await this.ffmpeg.buildSilentClip(pad, 3, tw, th, fps, 'black');
        if (fs.existsSync(pad)) segs.push(pad);
        progress();
        continue;
      }
      segs.push(seg);
      this.log(
        episodeId,
        'info',
        `第 ${sb.number} 镜规整完成（${audioLocal ? '含对白音轨' : '原声'}${transpose ? '，已旋转校正' : ''}）`,
      );
      progress();
    }

    if (segs.length === 0) {
      this.log(episodeId, 'error', '没有可用片段，合成中止');
      return;
    }
    const out = this.storage.mergeOutput(dramaId, episodeId);
    this.log(episodeId, 'info', '🔗 拼接各分镜为成片...');
    const merged = await this.ffmpeg.concatSegments(segs, out.abs);
    if (!merged) {
      this.log(episodeId, 'error', '成片拼接失败，请检查 ffmpeg 日志');
      return;
    }
    await this.prisma.episode.update({
      where: { id: episodeId },
      data: { merged: true, mergedUrl: out.url, status: 'completed' },
    });
    // 清理规整中间文件，保留成片
    for (const s of [...segs, ...mergeTemps]) {
      try {
        await fs.promises.rm(s, { force: true });
      } catch {
        /* ignore */
      }
    }
    this.sbEmit(episodeId, 'merge', { progress: 100, url: out.url });
    this.log(
      episodeId,
      'success',
      `✅ 合成完成，成片 ${out.url}（${tw}x${th} @${fps}fps，声轨完整）`,
    );
  }

  /** resolution 文本 → 像素尺寸（保持画面比例） */
  private resolutionOf(cfg: any): [number, number] {
    const ratio = String(cfg.aspect_ratio || '9:16');
    const [rw, rh] = ratio.split(':').map(Number);
    const is1080 = /1080/.test(String(cfg.resolution || '1080p'));
    const longSide = is1080 ? 1080 : 720;
    if (rw >= rh) {
      const w = Math.min(longSide, Math.round((longSide * rw) / rh / 2) * 2);
      const h = Math.round((w * rh) / rw / 2) * 2;
      return [w, h];
    }
    const h = Math.min(longSide, Math.round((longSide * rh) / rw / 2) * 2);
    const w = Math.round((h * rw) / rh / 2) * 2;
    return [w, h];
  }


  // ==================== 底层能力 ====================

  /** 后台执行：异常写入日志，结束后广播 done */
  private fire(episodeId: number, scope: 'episode' | 'asset', task: () => Promise<any>) {
    void Promise.resolve()
      .then(task)
      .catch((e: any) => {
        this.log(episodeId, 'error', `生成失败：${e?.message ?? e}`);
        this.logBus.emit(episodeId, {
          type: 'error',
          data: { text: e?.message ?? '生成失败' },
        });
      })
      .finally(() => {
        this.logBus.emit(episodeId, { type: 'done', data: { scope } });
      });
  }

  private async image(params: {
    /** 用于日志/SSE 推送的归属分集 */
    episodeId: number;
    /** 落盘目录使用的分集 id，默认同 episodeId；角色等整剧资源传 0（剧集级共享目录） */
    saveDirId?: number;
    dramaId: number;
    label: string;
    prompt: string;
    filename: string;
    ratio?: string;
    size?: string;
    images?: string[];
  }): Promise<StoredAsset | null> {
    if (!this.factory.isLive('image')) {
      this.log(
        params.episodeId,
        'warn',
        `${params.label}：模拟模式（未配置 AGNES_API_KEY），未真正调用生图`,
      );
      await sleep(400);
      return null;
    }

    const provider = this.factory.resolve('image');
    const res = await this.rate.schedule('image', () =>
      this.rate.withRetry(
        params.label,
        () =>
          provider.generate('image', {
            prompt: params.prompt,
            options: {
              ratio: params.ratio ?? '9:16',
              size: params.size ?? '2K',
              images: params.images,
            },
          }),
        (attempt, delay, reason) =>
          this.log(
            params.episodeId,
            'warn',
            `${params.label}：生图重试 ${attempt} 次（${reason}），${Math.round(delay / 1000)}s 后继续`,
          ),
      ),
    );

    this.log(params.episodeId, 'info', `${params.label}：生图完成，落盘素材`);
    return this.storage.saveImage(
      params.dramaId,
      params.saveDirId ?? params.episodeId,
      params.filename,
      { url: res.url, b64: res.b64 },
    );
  }

  private async loadStoryboard(id: number): Promise<LoadedStoryboard> {
    const sb = await this.prisma.storyboard.findFirst({
      where: { id, deletedAt: null },
      include: {
        character: true,
        scene: true,
        prop: true,
        episode: { include: { drama: true } },
      },
    });
    if (!sb) throw new NotFoundException(`分镜 ${id} 不存在`);

    // 多选角色/道具：解析 characterIds/propIds JSON，回退到单值 characterId/propId
    const characterIds = this.parseIds(sb.characterIds, sb.characterId);
    const propIds = this.parseIds(sb.propIds, sb.propId);

    let characters: any[] = [];
    let props: any[] = [];
    if (characterIds.length > 0) {
      characters = await this.prisma.character.findMany({
        where: { id: { in: characterIds }, deletedAt: null },
        orderBy: { id: 'asc' },
      });
      // 按 characterIds 的顺序排列，保证生成时主体角色排在前面
      const byId = new Map(characters.map((c) => [c.id, c]));
      characters = characterIds.map((cid) => byId.get(cid)).filter(Boolean);
    }
    if (propIds.length > 0) {
      props = await this.prisma.prop.findMany({
        where: { id: { in: propIds }, deletedAt: null },
        orderBy: { id: 'asc' },
      });
      const byId = new Map(props.map((p) => [p.id, p]));
      props = propIds.map((pid) => byId.get(pid)).filter(Boolean);
    }

    return {
      ...sb,
      characterIds,
      propIds,
      characters,
      props,
    } as unknown as LoadedStoryboard;
  }

  /** 解析多选 id：优先 characterIds/propIds JSON，回退单值，容错 */
  private parseIds(json?: string | null, single?: number | null): number[] {
    if (json) {
      try {
        const arr = JSON.parse(json);
        if (Array.isArray(arr)) {
          return arr.filter((v) => Number.isInteger(v));
        }
      } catch {
        /* fallthrough */
      }
      const parts = json.split(',').map((s) => Number(s.trim()));
      return parts.filter((v) => Number.isInteger(v));
    }
    return single != null ? [single] : [];
  }

  /** 上一分镜的尾帧绝对路径（用于本镜首帧衔接） */
  private async prevTailFrame(episodeId: number, number: number) {
    const prev = await this.prisma.storyboard.findFirst({
      where: { episodeId, deletedAt: null, number: { lt: number } },
      orderBy: { number: 'desc' },
      select: { lastFrameUrl: true },
    });
    const rel = prev?.lastFrameUrl;
    if (!rel || !rel.startsWith('/uploads/')) return null;
    return this.absOf(rel);
  }

  /**
   * /uploads/... 本地路径 → 磁盘绝对路径。
   * 路径拼装与目录穿越护栏统一由 StorageService.absFromUrl() 提供，
   * 此处仅作委托，避免两份实现漂移（曾因只改一处导致护栏失效）。
   */
  private absOf(uploadsPath?: string | null): string | null {
    return this.storage.absFromUrl(uploadsPath);
  }

  /** 该剧角色名单（用于场景/道具生成的命名消歧，缓存避免并发重复查库） */
  private readonly roleCtxCache = new Map<number, string>();
  private async roleNameContext(dramaId: number): Promise<string> {
    const hit = this.roleCtxCache.get(dramaId);
    if (hit !== undefined) return hit;
    const chars = await this.prisma.character.findMany({
      where: { dramaId, deletedAt: null },
      select: { name: true, roleLabel: true },
    });
    const ctx = chars
      .map((c) => `「${c.name}」${c.roleLabel ? `=${c.roleLabel}` : '=人物'}`)
      .join('、');
    this.roleCtxCache.set(dramaId, ctx);
    return ctx;
  }

  private async firstEpisodeIdOfDrama(dramaId: number) {
    const ep = await this.prisma.episode.findFirst({
      where: { dramaId, deletedAt: null },
      orderBy: { episodeNumber: 'asc' },
      select: { id: true },
    });
    // 角色属整剧，无分集时日志无处可去，返回 0 由 log() 忽略
    return ep?.id ?? 0;
  }

  private log(episodeId: number, level: string, text: string) {
    if (!episodeId) return;
    this.logBus.emit(episodeId, {
      type: 'log',
      data: { level, text, at: new Date().toISOString() },
    });
  }

  private status(episodeId: number, id: number, status: string, progress: number) {
    if (!episodeId) return;
    this.logBus.emit(episodeId, {
      type: 'storyboard',
      data: { id, status, progress },
    });
  }

  private sbEmit(episodeId: number, event: 'merge', data: any) {
    this.logBus.emit(episodeId, { type: event, data });
  }

  /** 方言三级级联：分镜 > 角色 > 剧集 > 默认 */
  resolveDialectLabel(sb: {
    dialect?: string | null;
    character?: { dialect?: string | null } | null;
    dramaDialect?: string | null;
  }) {
    return DIALECT_LABEL[this.resolveDialectKey(sb)] || '标准普通话';
  }

  /** 方言三级级联取 KEY（用于挑选 TTS 音色）；未命中返回 standard */
  resolveDialectKey(sb: {
    dialect?: string | null;
    character?: { dialect?: string | null } | null;
    dramaDialect?: string | null;
  }): string {
    const keys = Object.keys(DIALECT_LABEL);
    if (sb.dialect && keys.includes(sb.dialect)) return sb.dialect;
    if (sb.character?.dialect && keys.includes(sb.character.dialect)) {
      return sb.character.dialect;
    }
    if (sb.dramaDialect && keys.includes(sb.dramaDialect)) {
      return sb.dramaDialect;
    }
    return 'standard';
  }

  /** 读取分集生成一致性配置（genCfg JSON → GenStyle），缺省全剧统一 */
  private async resolveGenCfgOfEpisode(episodeId: number): Promise<GenStyle> {
    const ep = await this.prisma.episode.findFirst({
      where: { id: episodeId, deletedAt: null },
      select: { genCfg: true },
    });
    if (!ep?.genCfg) return { ...DEFAULT_GEN_CFG };
    try {
      return { ...DEFAULT_GEN_CFG, ...JSON.parse(ep.genCfg) };
    } catch {
      return { ...DEFAULT_GEN_CFG };
    }
  }
}
