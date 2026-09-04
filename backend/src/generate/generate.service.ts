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
import { GenStyle } from '../ai/prompt.service';
import { FfmpegService } from '../ai/ffmpeg.service';
import { ProviderAuthError, ProviderTransientError } from '../ai/provider.types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const DIALECT_LABEL: Record<string, string> = {
  standard: '标准普通话',
  zh_xian: '西安话',
  zh_dongbei: '东北话',
  zh_yueyu: '粤语',
  zh_chengdu: '成都话',
  zh_shanghai: '上海话',
};

/** 分集生成一致性配置（genCfg JSON，缺省全剧统一：中文 + 禁止唱词） */
export interface EpisodeGenCfg {
  language: string;
  allowSinging: boolean;
}
const DEFAULT_GEN_CFG: EpisodeGenCfg = { language: 'zh-CN', allowSinging: false };

/** 一键生成分步选项（缺省 = 素材四步：角色/场景/道具/分镜首尾帧） */
export interface GenerateEpisodeOpts {
  steps?: {
    characters?: boolean;
    scenes?: boolean;
    props?: boolean;
    storyboardImages?: boolean;
    storyboardVideos?: boolean;
    storyboardAudio?: boolean;
    merge?: boolean;
  };
}

/** v2.5-flash 单段视频仅支持 4–12 秒 */
const clampSeconds = (duration?: number | null) =>
  String(Math.min(12, Math.max(4, Math.round(duration ?? 5))));

/** AI 剧本拆解的结构化产物（已规范化：空名剔除、取值夹取） */
export interface ParsedScript {
  characters: Array<{
    name: string;
    role: string | null;
    roleLabel: string | null;
    appearance: string | null;
    intro: string | null;
  }>;
  scenes: Array<{
    location: string;
    time: string | null;
    description: string | null;
  }>;
  props: Array<{
    name: string;
    type: string | null;
    description: string | null;
  }>;
  storyboards: Array<{
    character: string | null;
    scene: string | null;
    prop: string | null;
    dialogue: string | null;
    narration: string | null;
    sceneDescription: string | null;
    motionDescription: string | null;
    emotion: string;
    duration: number;
  }>;
}

/** 锚点文本标记：用于判断锚点是否已由本系统提炼过 */
const STYLE_MARK = '国产可爱动画风格';

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
  scene: any;
  prop: any;
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
  /** 单分镜任务锁 */
  private sbRunning = new Set<number>();
  /** 单分镜配音任务锁 */
  private dubRunning = new Set<number>();

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
    this.fire(episodeId, 'asset', () => this.runCharacter(c, episodeId));
    return { started: true, episodeId, characterId: c.id };
  }

  private async runCharacter(c: any, episodeId: number) {
    const tag = `角色「${c.name}」`;

    // 先提炼视觉锚点（跨分镜一致性基础）
    let anchors: string | null = c.anchors;
    if (!anchors || !anchors.includes(STYLE_MARK)) {
      anchors = await this.prompt.buildCharacterAnchorText(c);
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
      prompt: this.prompt.characterImagePrompt({ ...c, anchors }),
      filename: `char-${c.id}-${Date.now()}.png`,
      ratio: '9:16',
    });
    if (asset) {
      await this.prisma.character.update({
        where: { id: c.id },
        data: { imageUrl: asset.url, sourceUrl: asset.remote ?? null },
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
    this.fire(s.episodeId, 'asset', () => this.runScene(s, opts));
    return { started: true, episodeId: s.episodeId, sceneId: s.id };
  }

  private async runScene(s: any, opts: { quad?: boolean } = {}) {
    const quad = opts.quad ?? s.useQuadGrid;
    const tag = `场景「${s.location}」${quad ? '（四宫格）' : '（单图）'}`;
    const asset = await this.image({
      episodeId: s.episodeId,
      dramaId: s.episode.dramaId,
      label: tag,
      prompt: this.prompt.sceneImagePrompt(s, quad),
      filename: `scene-${s.id}-${quad ? 'quad' : 'single'}-${Date.now()}.png`,
      ratio: '9:16',
    });
    if (asset) {
      await this.prisma.scene.update({
        where: { id: s.id },
        data: {
          imageUrl: asset.url,
          sourceUrl: asset.remote ?? null,
          useQuadGrid: quad,
        },
      });
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
    this.fire(p.episodeId, 'asset', () => this.runProp(p, opts));
    return { started: true, episodeId: p.episodeId, propId: p.id };
  }

  private async runProp(p: any, opts: { quad?: boolean } = {}) {
    const quad = opts.quad ?? p.useQuadGrid;
    const tag = `道具「${p.name}」${quad ? '（四视图）' : '（单图）'}`;
    const asset = await this.image({
      episodeId: p.episodeId,
      dramaId: p.episode.dramaId,
      label: tag,
      prompt: this.prompt.propImagePrompt(p, quad),
      filename: `prop-${p.id}-${quad ? 'quad' : 'single'}-${Date.now()}.png`,
      ratio: '1:1',
    });
    if (asset) {
      await this.prisma.prop.update({
        where: { id: p.id },
        data: {
          imageUrl: asset.url,
          sourceUrl: asset.remote ?? null,
          useQuadGrid: quad,
        },
      });
      this.log(p.episodeId, 'success', `${tag} 生成完成`);
    }
  }

  // ==================== ④ 分镜参考图（首帧 + 尾帧） ====================

  async generateStoryboardImage(storyboardId: number, opts: { force?: boolean } = {}) {
    const sb = await this.loadStoryboard(storyboardId);
    if (sb.imageUrl && sb.lastFrameUrl && !opts.force) {
      this.log(sb.episodeId, 'info', `[分镜#${sb.number}] 参考图已存在，跳过`);
      return { started: false, episodeId: sb.episodeId, reason: 'already_generated' };
    }
    this.fire(sb.episodeId, 'asset', () => this.runStoryboardImage(sb, opts));
    return { started: true, episodeId: sb.episodeId, storyboardId: sb.id };
  }

  async runStoryboardImage(
    sb: LoadedStoryboard,
    opts: { force?: boolean } = {},
    style?: GenStyle,
  ) {
    if (sb.imageUrl && sb.lastFrameUrl && !opts.force) return;

    // force 重生成时丢弃旧提示词，避免被当作「自定义提示词」拼接造成指令冲突
    if (opts.force) sb.imagePrompt = null;

    const ctx = { sb, character: sb.character, scene: sb.scene, prop: sb.prop };

    // 跨分镜一致性参考：优先角色形象图（整剧共享，锁定人物风格），
    // 再衔接上一镜视频尾帧（保证镜头连续）。
    const references: string[] = [];
    if (sb.character?.imageUrl) {
      const charRef = await this.storage.toDataUri(sb.character.imageUrl);
      if (charRef) references.push(charRef);
    }
    const prevTail = await this.prevTailFrame(sb.episodeId, sb.number);
    if (prevTail) {
      const tailRef = await this.storage.toDataUri(prevTail);
      if (tailRef) references.push(tailRef);
      this.log(sb.episodeId, 'info', `[分镜#${sb.number}] 已衔接上一镜尾帧作为画面参考`);
    }
    if (references.length > 0) {
      this.log(
        sb.episodeId,
        'info',
        `[分镜#${sb.number}] 已注入${references.length}张一致性参考图（角色形象/上一镜尾帧）`,
      );
    }

    const firstPrompt = this.prompt.storyboardImagePrompt(ctx, style);
    const first = await this.image({
      episodeId: sb.episodeId,
      dramaId: sb.episode.dramaId,
      label: `[分镜#${sb.number}] 首帧`,
      prompt: firstPrompt,
      filename: `sb-${sb.number}-first-${Date.now()}.png`,
      ratio: '9:16',
      images: references.length > 0 ? references : undefined,
    });

    const data: any = { imagePrompt: firstPrompt };
    if (first) {
      data.imageUrl = first.url;
      data.sourceUrl = first.remote ?? null;
    }
    await this.prisma.storyboard.update({ where: { id: sb.id }, data });

    // 尾帧：以首帧为参考做图生图，保证同场景同人物
    const firstRef =
      first?.remote || (first?.abs ? await this.storage.toDataUri(first.abs) : null);
    if (firstRef) {
      const tail = await this.image({
        episodeId: sb.episodeId,
        dramaId: sb.episode.dramaId,
        label: `[分镜#${sb.number}] 尾帧`,
        prompt: this.prompt.storyboardLastFramePrompt(ctx),
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
    const ctx = { sb, character: sb.character, scene: sb.scene };
    const prompt = this.prompt.videoPrompt(ctx, style);
    this.status(sb.episodeId, sb.id, 'generating', 5);

    if (!this.factory.isLive('video')) {
      await sleep(800);
      await this.prisma.storyboard.update({
        where: { id: sb.id },
        data: { videoPrompt: prompt, status: 'finished' },
      });
      this.log(
        sb.episodeId,
        'warn',
        `[分镜#${sb.number}] 模拟模式（未配置 AGNES_API_KEY），视频未真正生成`,
      );
      this.status(sb.episodeId, sb.id, 'finished', 100);
      return;
    }

    // keyframe 需要可被 Agnes 公开访问的媒体地址
    const firstFrame = this.storage.absoluteUrl(sb.sourceUrl || sb.imageUrl);
    const lastFrame = this.storage.absoluteUrl(
      sb.lastFrameSourceUrl || sb.lastFrameUrl,
    );
    const mode = firstFrame || lastFrame ? 'keyframe' : 'text';
    if (mode === 'text') {
      this.log(
        sb.episodeId,
        'warn',
        `[分镜#${sb.number}] 首帧无公开访问地址，降级为文生视频（配置 PUBLIC_BASE_URL 可启用首尾帧控制）`,
      );
    }

    const provider = this.factory.resolve('video');
    const created = await this.rate.schedule('video', () =>
      this.rate.withRetry(
        `[分镜#${sb.number}] 视频`,
        () =>
          provider.generate('video', {
            prompt,
            options: {
              mode,
              seconds: clampSeconds(sb.duration),
              size: '720P',
              aspectRatio: '9:16',
              firstFrame,
              lastFrame,
            },
          }),
        (attempt, delay, reason) =>
          this.log(
            sb.episodeId,
            'warn',
            `[分镜#${sb.number}] 视频请求重试 ${attempt} 次（${reason}），${Math.round(delay / 1000)}s 后继续`,
          ),
      ),
    );

    const taskId = created.taskId!;
    this.log(sb.episodeId, 'info', `[分镜#${sb.number}] 视频任务已创建（${taskId}）`);

    const url = await this.pollVideo(sb, provider, taskId);
    const asset = await this.storage.saveVideo(
      sb.episode.dramaId,
      sb.episodeId,
      `sb-${sb.number}-${Date.now()}.mp4`,
      { url },
    );

    await this.prisma.storyboard.update({
      where: { id: sb.id },
      data: { videoPrompt: prompt, videoUrl: asset.url, status: 'finished' },
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
    await this.prisma.storyboard.update({
      where: { id: sb.id },
      data: { lastFrameUrl: rel },
    });
    this.log(sb.episodeId, 'info', `[分镜#${sb.number}] 尾帧已提取，将作为下一镜画面参考`);
  }

  // ==================== ④ 分镜配音（TTS，对白/旁白 → 音轨） ====================

  async generateStoryboardAudio(
    storyboardId: number,
    opts: { force?: boolean } = {},
  ) {
    const sb = await this.loadStoryboard(storyboardId);
    if (this.dubRunning.has(sb.id)) {
      throw new ForbiddenException('该分镜正在生成配音中');
    }
    if (sb.audioUrl && !opts.force) {
      this.log(sb.episodeId, 'info', `[分镜#${sb.number}] 配音已存在，跳过`);
      return { started: false, episodeId: sb.episodeId, reason: 'already_generated' };
    }
    const text = (sb.dialogue || sb.narration || '').trim();
    if (!text) {
      this.log(sb.episodeId, 'info', `[分镜#${sb.number}] 无对白/旁白文本，跳过配音`);
      return { started: false, episodeId: sb.episodeId, reason: 'no_text' };
    }
    this.fire(sb.episodeId, 'asset', () => this.runStoryboardAudio(sb, text, opts));
    return { started: true, episodeId: sb.episodeId, storyboardId: sb.id };
  }

  private async runStoryboardAudio(
    sb: LoadedStoryboard,
    text: string,
    opts: { force?: boolean } = {},
  ) {
    this.dubRunning.add(sb.id);
    try {
      // 仅生成配音存 audioUrl（供合成成片可选混入），不替换分镜视频原声
      return await this.synthesizeAudio(sb, text, opts.force ?? false);
    } finally {
      this.dubRunning.delete(sb.id);
    }
  }

  /** 生成 TTS 配音并落库，返回配音真实时长（秒）；无可用 TTS 或失败返回 null */
  private async synthesizeAudio(
    sb: LoadedStoryboard,
    text: string,
    force: boolean,
  ): Promise<number | null> {
    if (!this.factory.isLive('tts')) {
      this.log(
        sb.episodeId,
        'warn',
        `[分镜#${sb.number}] 无可用 TTS 服务，跳过真实配音，分镜保留 AI 原声`,
      );
      return null;
    }
    const dialectKey = this.resolveDialectKey({
      dialect: sb.dialect,
      character: sb.character,
      dramaDialect: sb.episode.drama?.dialect,
    });
    const dialectLabel = DIALECT_LABEL[dialectKey] || '标准普通话';
    const provider = this.factory.resolve('tts');
    const res = await this.rate.withRetry(
      `[分镜#${sb.number}] 配音`,
      () =>
        provider.generate('tts', {
          prompt: text,
          options: { dialect: dialectKey, speed: 1.0 },
        }),
      (attempt, delay, reason) =>
        this.log(
          sb.episodeId,
          'warn',
          `[分镜#${sb.number}] 配音请求重试 ${attempt} 次（${reason}），${Math.round(delay / 1000)}s 后继续`,
        ),
    );

    const asset = await this.storage.saveAudio(
      sb.episode.dramaId,
      sb.episodeId,
      `sb-${sb.number}-dub-${Date.now()}.mp3`,
      { b64: res.b64 },
    );
    await this.prisma.storyboard.update({
      where: { id: sb.id },
      data: { audioUrl: asset.url },
    });
    let dur: number | null = null;
    const local = this.storage.absFromUrl(asset.url);
    if (local && fs.existsSync(local)) {
      try {
        const info = await this.ffmpeg.probe(local);
        dur = info?.duration ?? null;
      } catch {
        /* 探测失败不阻断 */
      }
    }
    this.log(
      sb.episodeId,
      'success',
      `[分镜#${sb.number}] 配音生成完成（${dialectLabel}${dur ? `，${dur.toFixed(1)}s` : ''}）`,
    );
    return dur;
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

  /**
   * 一键成剧集：按勾选步骤依次执行。
   * 缺省 = 素材四步（①角色 → ②场景 → ③道具 → ④分镜首尾帧），
   * 可扩展 ⑤分镜视频 / ⑥分镜配音 / ⑦合成成片，形成完整流水线。
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
      storyboardAudio: opts.steps?.storyboardAudio === true,
      merge: opts.steps?.merge === true,
    };
    const style = await this.resolveGenCfgOfEpisode(episodeId);
    const stepNames = [
      steps.characters && '①角色',
      steps.scenes && '②场景',
      steps.props && '③道具',
      steps.storyboardImages && '④分镜首尾帧',
      steps.storyboardVideos && '⑤分镜视频',
      steps.storyboardAudio && '⑥分镜配音',
      steps.merge && '⑦合成成片',
    ]
      .filter(Boolean)
      .join(' → ');
    try {
      if (this.rate.isCircuitOpen()) {
        this.log(episodeId, 'error', `生成已熔断：${this.rate.circuitMessage()}`);
        return;
      }
      this.log(episodeId, 'info', `🚀 一键生成开始：${stepNames}`);

      // ① 角色（整剧共享，只补缺图的）
      if (steps.characters) {
        const characters = await this.prisma.character.findMany({
          where: { dramaId, deletedAt: null },
        });
        this.log(episodeId, 'info', `① 角色 ${characters.length} 个，生成缺失的形象图`);
        for (const c of characters) {
          if (c.imageUrl) {
            this.log(episodeId, 'info', `角色「${c.name}」已有形象，跳过`);
            continue;
          }
          try {
            await this.runCharacter(c, episodeId);
          } catch (e: any) {
            this.log(episodeId, 'error', `角色「${c.name}」生成失败：${e.message}`);
          }
        }
      }

      // ② 场景
      if (steps.scenes) {
        const scenes = await this.prisma.scene.findMany({
          where: { episodeId, deletedAt: null },
          include: { episode: true },
        });
        this.log(episodeId, 'info', `② 场景 ${scenes.length} 个，生成缺失的场景图`);
        for (const s of scenes) {
          if (s.imageUrl) {
            this.log(episodeId, 'info', `场景「${s.location}」已有图，跳过`);
            continue;
          }
          try {
            await this.runScene(s);
          } catch (e: any) {
            this.log(episodeId, 'error', `场景「${s.location}」生成失败：${e.message}`);
          }
        }
      }

      // ③ 道具
      if (steps.props) {
        const props = await this.prisma.prop.findMany({
          where: { episodeId, deletedAt: null },
          include: { episode: true },
        });
        this.log(episodeId, 'info', `③ 道具 ${props.length} 个，生成缺失的道具图`);
        for (const p of props) {
          if (p.imageUrl) {
            this.log(episodeId, 'info', `道具「${p.name}」已有图，跳过`);
            continue;
          }
          try {
            await this.runProp(p);
          } catch (e: any) {
            this.log(episodeId, 'error', `道具「${p.name}」生成失败：${e.message}`);
          }
        }
      }

      // ④ 分镜首尾帧
      const list = await this.prisma.storyboard.findMany({
        where: { episodeId, deletedAt: null },
        orderBy: { number: 'asc' },
        select: { id: true, number: true },
      });
      if (list.length === 0) {
        this.log(episodeId, 'warn', '暂无分镜，先添加分镜后再生成');
      } else {
        if (steps.storyboardImages) {
          this.log(episodeId, 'info', `④ 分镜 ${list.length} 个，生成首帧+尾帧参考图`);
          for (const item of list) {
            try {
              this.status(episodeId, item.id, 'generating', 10);
              const sb = await this.loadStoryboard(item.id);
              await this.runStoryboardImage(sb, {}, style);
              this.status(episodeId, item.id, 'pending', 60);
            } catch (e: any) {
              this.status(episodeId, item.id, 'cancelled', 0);
              this.log(episodeId, 'error', `[分镜#${item.number}] 参考图生成失败：${e.message}`);
            }
          }
        }

        // ⑤ 分镜视频（仅补缺失）
        if (steps.storyboardVideos) {
          this.log(episodeId, 'info', `⑤ 分镜 ${list.length} 个，生成缺失的视频`);
          for (const item of list) {
            try {
              const sb = await this.loadStoryboard(item.id);
              if (sb.videoUrl) {
                this.log(episodeId, 'info', `[分镜#${sb.number}] 视频已存在，跳过`);
                continue;
              }
              await this.runStoryboardVideoFlow(sb, {}, style);
            } catch (e: any) {
              this.status(episodeId, item.id, 'cancelled', 0);
              this.log(episodeId, 'error', `[分镜#${item.number}] 视频生成失败：${e.message}`);
            }
          }
        }

        // ⑥ 分镜配音（仅补缺失）
        if (steps.storyboardAudio) {
          this.log(episodeId, 'info', `⑥ 分镜 ${list.length} 个，生成缺失的配音`);
          for (const item of list) {
            try {
              const sb = await this.loadStoryboard(item.id);
              const text = (sb.dialogue || sb.narration || '').trim();
              if (!text) {
                this.log(episodeId, 'info', `[分镜#${sb.number}] 无对白/旁白，跳过配音`);
                continue;
              }
              if (sb.audioUrl) {
                this.log(episodeId, 'info', `[分镜#${sb.number}] 配音已存在，跳过`);
                continue;
              }
              await this.runStoryboardAudio(sb, text, {});
            } catch (e: any) {
              this.log(episodeId, 'error', `[分镜#${item.number}] 配音生成失败：${e.message}`);
            }
          }
        }
      }

      await this.prisma.episode.update({
        where: { id: episodeId },
        data: { status: 'editing' },
      });
      this.log(
        episodeId,
        'success',
        `🎉 一键生成完成：${stepNames}${steps.merge ? '' : '（如需视频/配音/合成，可在生成选项或分镜面板继续）'}`,
      );

      // ⑦ 合成成片（放在最后，等视频/配音就绪）
      if (steps.merge) {
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
      where: { episodeId, characterId: { not: null } },
      select: { characterId: true },
    });
    const usedCharIds = [
      ...new Set(sbChars.map((r) => r.characterId as number)),
    ];
    const [sb, sc, pr] = await this.prisma.$transaction([
      this.prisma.storyboard.deleteMany({ where: { episodeId } }),
      this.prisma.scene.deleteMany({ where: { episodeId } }),
      this.prisma.prop.deleteMany({ where: { episodeId } }),
    ]);

    // ③ 删除「重置后全剧再无任何分镜引用」的角色（仍被其他分集引用则保留）
    let chDeleted = 0;
    for (const cid of usedCharIds) {
      const remain = await this.prisma.storyboard.count({
        where: {
          characterId: cid,
          episodeId: { not: episodeId },
          deletedAt: null,
        },
      });
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

  private static readonly EMOTIONS = [
    'neutral',
    'happy',
    'sad',
    'angry',
    'fear',
    'surprise',
  ] as const;

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
    const parsed = this.normalizeParsedScript(body?.parsed);
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
    this.log(
      episode.id,
      'info',
      '🤖 正在调用文本模型拆解剧本，请稍候（约 10~60 秒）...',
    );
    const prompt = [
      '你是资深短剧分镜师。请阅读下面的漫剧剧本，把它拆解为可直接投产的结构化数据。',
      '',
      '项目信息：',
      `剧名：${episode.drama.title}`,
      episode.drama.dialect ? `剧集方言：${episode.drama.dialect}` : '',
      `分集标题：${episode.title}`,
      episode.description ? `分集简介：${episode.description}` : '',
      '',
      '输出要求（务必遵守）：',
      '1. 只输出一个 JSON 对象，不要任何解释、Markdown 代码块标记或多余文字。',
      '2. JSON 结构如下：',
      '{"characters":[{"name":"角色名","role":"main|supporting|minor","roleLabel":"一句话身份标签","appearance":"外貌描述80~150字：发型发色、五官、体型、标志性特征、整体气质","intro":"角色简介100字内"}],',
      ' "scenes":[{"location":"场景地点","time":"时间段如白天/夜晚，可为空字符串","description":"场景描述80~150字"}],',
      ' "props":[{"name":"道具名","type":"道具类型","description":"道具描述50~100字"}],',
      ' "storyboards":[{"character":"角色名，须与characters中name一致","scene":"场景地点，须与scenes中location一致","prop":"道具名，无则空字符串","dialogue":"本镜对白1~3句，可空","narration":"旁白1~2句，可空","sceneDescription":"画面描述：内容/景别/构图/机位，1~3句","motionDescription":"动作与运镜描述，1~3句","emotion":"neutral|happy|sad|angry|fear|surprise","duration":5}]}',
      '3. 分镜须完整覆盖剧本情节并按叙事顺序排列；每镜时长为 4~12 的整数秒。',
      '4. 角色只收录有台词或关键动作的角色；场景、道具只收录需要出图的关键项，不要凑数。',
      '',
      '剧本原文：',
      (episode.scriptText || '').trim(),
    ]
      .filter((l) => l !== '')
      .join('\n');

    const provider = this.factory.resolve('text');
    const res = await provider.generate('text', {
      prompt,
      options: { temperature: 0.4, maxTokens: 8000 },
    });
    return this.normalizeParsedScript(this.extractJsonObject(res.text || ''));
  }

  /** 规范化拆解结构：剔除空名条目、丢弃全空分镜、夹取取值范围 */
  private normalizeParsedScript(raw: any): ParsedScript {
    const src = raw && typeof raw === 'object' ? raw : {};
    const arr = (v: any) => (Array.isArray(v) ? v : []);
    const characters = arr(src.characters)
      .map((c: any) => ({
        name: this.normStr(c?.name) ?? '',
        role: this.normStr(c?.role),
        roleLabel: this.normStr(c?.roleLabel),
        appearance: this.normStr(c?.appearance),
        intro: this.normStr(c?.intro),
      }))
      .filter((c: any) => c.name);
    const scenes = arr(src.scenes)
      .map((s: any) => ({
        location: this.normStr(s?.location) ?? '',
        time: this.normStr(s?.time),
        description: this.normStr(s?.description),
      }))
      .filter((s: any) => s.location);
    const props = arr(src.props)
      .map((p: any) => ({
        name: this.normStr(p?.name) ?? '',
        type: this.normStr(p?.type),
        description: this.normStr(p?.description),
      }))
      .filter((p: any) => p.name);
    const storyboards = arr(src.storyboards)
      .map((sb: any) => ({
        character: this.normStr(sb?.character),
        scene: this.normStr(sb?.scene),
        prop: this.normStr(sb?.prop),
        dialogue: this.normStr(sb?.dialogue),
        narration: this.normStr(sb?.narration),
        sceneDescription: this.normStr(sb?.sceneDescription),
        motionDescription: this.normStr(sb?.motionDescription),
        emotion: this.normEmotion(sb?.emotion),
        duration: this.normDuration(sb?.duration),
      }))
      .filter(
        (sb: any) =>
          sb.dialogue || sb.narration || sb.sceneDescription || sb.motionDescription,
      );
    return { characters, scenes, props, storyboards };
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

    // ① 替换模式：先硬删除本集已有分镜 / 场景 / 道具
    if (mode === 'replace') {
      const [sb, sc, pr] = await this.prisma.$transaction([
        this.prisma.storyboard.deleteMany({ where: { episodeId } }),
        this.prisma.scene.deleteMany({ where: { episodeId } }),
        this.prisma.prop.deleteMany({ where: { episodeId } }),
      ]);
      this.log(
        episodeId,
        'info',
        `🗑️ 已清空本集旧数据：分镜 ${sb.count} 条、场景 ${sc.count} 条、道具 ${pr.count} 条`,
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
    let charCreated = 0;
    for (const c of characters) {
      const name = this.normStr(c?.name);
      if (!name) continue;
      const existId = charMap.get(name);
      if (existId) {
        const patch: any = {};
        const roleLabel = this.normStr(c?.roleLabel);
        const appearance = this.normStr(c?.appearance);
        const intro = this.normStr(c?.intro);
        if (roleLabel) patch.roleLabel = roleLabel;
        if (appearance) patch.appearance = appearance;
        if (intro) patch.intro = intro;
        if (Object.keys(patch).length) {
          await this.prisma.character.update({
            where: { id: existId },
            data: patch,
          });
        }
        continue;
      }
      const created = await this.prisma.character.create({
        data: {
          dramaId: episode.dramaId,
          name,
          role: this.normStr(c?.role) || 'supporting',
          roleLabel: this.normStr(c?.roleLabel),
          appearance: this.normStr(c?.appearance),
          intro: this.normStr(c?.intro),
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

    // ④ 场景 / 道具：直接创建（分集私有；同名场景允许跨集存在）
    const sceneMap = new Map<string, number>();
    let sceneCreated = 0;
    for (const s of scenes) {
      const location = this.normStr(s?.location);
      if (!location) continue;
      const created = await this.prisma.scene.create({
        data: {
          episodeId,
          location,
          time: this.normStr(s?.time),
          description: this.normStr(s?.description),
        },
      });
      sceneMap.set(location, created.id);
      sceneCreated += 1;
    }
    const propMap = new Map<string, number>();
    let propCreated = 0;
    for (const p of props) {
      const name = this.normStr(p?.name);
      if (!name) continue;
      const created = await this.prisma.prop.create({
        data: {
          episodeId,
          name,
          type: this.normStr(p?.type),
          description: this.normStr(p?.description),
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
    let sbCreated = 0;
    for (let i = 0; i < storyboards.length; i += 1) {
      const sb = storyboards[i];
      const hasText =
        this.normStr(sb?.dialogue) ||
        this.normStr(sb?.narration) ||
        this.normStr(sb?.sceneDescription) ||
        this.normStr(sb?.motionDescription);
      if (!hasText) continue; // 全空的分镜直接丢弃
      const charName = this.normStr(sb?.character) ?? '';
      const sceneName = this.normStr(sb?.scene) ?? '';
      const propName = this.normStr(sb?.prop) ?? '';
      if (charName && !charMap.has(charName)) unknownChars.add(charName);
      if (sceneName && !sceneMap.has(sceneName)) unknownScenes.add(sceneName);
      if (propName && !propMap.has(propName)) unknownProps.add(propName);
      await this.prisma.storyboard.create({
        data: {
          episodeId,
          number: sbCreated + 1,
          characterId: charMap.get(charName) ?? null,
          sceneId: sceneMap.get(sceneName) ?? null,
          propId: propMap.get(propName) ?? null,
          dialogue: this.normStr(sb?.dialogue),
          narration: this.normStr(sb?.narration),
          sceneDescription: this.normStr(sb?.sceneDescription),
          motionDescription: this.normStr(sb?.motionDescription),
          emotion: this.normEmotion(sb?.emotion),
          duration: this.normDuration(sb?.duration),
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

  /** 从 AI 返回文本中稳健提取 JSON 对象（容忍代码块包裹与前后杂讯） */
  private extractJsonObject(raw: string): any {
    let s = (raw || '').trim();
    s = s.replace(/```(?:json)?/gi, '').trim();
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start < 0 || end <= start) {
      throw new Error('AI 返回内容中未找到 JSON，请重试');
    }
    try {
      return JSON.parse(s.slice(start, end + 1));
    } catch {
      throw new Error('AI 返回的 JSON 解析失败，请重试');
    }
  }

  private normStr(v: any): string | null {
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    return s || null;
  }

  private normEmotion(v: any): string {
    const s = String(v ?? '').trim();
    return (GenerateService.EMOTIONS as readonly string[]).includes(s)
      ? s
      : 'neutral';
  }

  private normDuration(v: any): number {
    const n = Number(v);
    if (!Number.isFinite(n)) return 5;
    return Math.min(12, Math.max(4, Math.round(n)));
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

      const audioLocal = this.storage.absFromUrl(sb.audioUrl);
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
    for (const s of segs) {
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
    return sb as unknown as LoadedStoryboard;
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

  private absOf(uploadsPath: string) {
    const root = path.resolve(
      process.cwd(),
      process.env.UPLOAD_DIR || '../data/uploads',
    );
    return path.join(root, uploadsPath.replace(/^\/uploads\//, ''));
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
