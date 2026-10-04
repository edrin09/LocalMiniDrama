import {
  Body,
  Controller,
  Param,
  ParseIntPipe,
  Post,
  Sse,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { GenerateService } from './generate.service';
import { GenerateEpisodeOpts } from './generate.service';
import { LogBusService } from './log-bus.service';
import { TextEnrichService, EnrichDto } from './text-enrich.service';

@Controller()
export class GenerateController {
  constructor(
    private readonly generate: GenerateService,
    private readonly logBus: LogBusService,
    private readonly enrich: TextEnrichService,
  ) {}

  // 生成日志 SSE 流（EventSource）：按分集订阅
  @Sse('episodes/:id/logs/stream')
  stream(@Param('id', ParseIntPipe) id: number): Observable<MessageEvent> {
    return this.logBus.subscribe(id) as unknown as Observable<MessageEvent>;
  }

  // 整剧级生成日志 SSE 流：按剧订阅（配合 generate-all / 整剧成片进度页）
  @Sse('dramas/:id/logs/stream')
  streamDrama(@Param('id', ParseIntPipe) id: number): Observable<MessageEvent> {
    return this.logBus.subscribeDrama(id) as unknown as Observable<MessageEvent>;
  }

  // 整剧一键成片：排队跑所有分集的完整流水线（拆解→素材→分镜→视频→配音→合成）
  @Post('dramas/:id/generate-all')
  generateAll(@Param('id', ParseIntPipe) id: number) {
    return this.generate.generateDrama(id);
  }

  // 整集一键生成：①角色 → ②场景 → ③道具 → ④分镜首尾帧（可勾选 ⑤视频/⑥合成）
  @Post('episodes/:id/generate')
  generateEpisode(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { steps?: GenerateEpisodeOpts['steps'] },
  ) {
    return this.generate.generateEpisode(id, { steps: body?.steps });
  }

  // 一键重新生成分镜素材：按当前剧本强制重做全部首尾帧 → 视频
  @Post('episodes/:id/regenerate-storyboards')
  regenerateStoryboards(@Param('id', ParseIntPipe) id: number) {
    return this.generate.regenerateStoryboards(id);
  }

  // 合成视频（⑤）
  @Post('episodes/:id/merge')
  merge(@Param('id', ParseIntPipe) id: number, @Body() cfg: any) {
    return this.generate.merge(id, cfg);
  }

  // 重置单个分集 = 清空重来：硬删本集分镜/场景/道具与素材，并按剧本原文自动重建
  @Post('episodes/:id/reset')
  resetEpisode(@Param('id', ParseIntPipe) id: number) {
    return this.generate.resetEpisode(id);
  }

  // 重置整部剧 = 清空重来：硬删所有记录与素材，并按剧本原文自动重建各分集
  @Post('dramas/:id/reset')
  resetDrama(@Param('id', ParseIntPipe) id: number) {
    return this.generate.resetDrama(id);
  }

  // AI 拆解剧本：按分集已保存的剧本原文生成角色/场景/道具/分镜记录（后台执行 + SSE 日志）
  @Post('episodes/:id/parse-script')
  parseScript(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { mode?: 'append' | 'replace' },
  ) {
    return this.generate.parseScript(id, { mode: body?.mode });
  }

  // AI 拆解剧本·预览：同步返回拆解结果 JSON，不落库（前端确认后调 apply）
  @Post('episodes/:id/parse-script/preview')
  previewParseScript(@Param('id', ParseIntPipe) id: number) {
    return this.generate.previewParseScript(id);
  }

  // AI 拆解剧本·应用：把预览确认过的拆解结果落库（后台执行 + SSE 日志）
  @Post('episodes/:id/parse-script/apply')
  applyParsedScript(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { mode?: 'append' | 'replace'; parsed?: any },
  ) {
    return this.generate.applyParsedScript(id, body ?? {});
  }

  // ==================== 单点生成 ====================

  @Post('characters/:id/generate')
  generateCharacter(@Param('id', ParseIntPipe) id: number) {
    return this.generate.generateCharacter(id);
  }

  @Post('scenes/:id/generate')
  generateScene(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { quad?: boolean; force?: boolean },
  ) {
    return this.generate.generateScene(id, body ?? {});
  }

  @Post('props/:id/generate')
  generateProp(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { quad?: boolean; force?: boolean },
  ) {
    return this.generate.generateProp(id, body ?? {});
  }

  @Post('storyboards/:id/generate-image')
  generateStoryboardImage(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { force?: boolean },
  ) {
    return this.generate.generateStoryboardImage(id, body ?? {});
  }

  @Post('storyboards/:id/generate-video')
  generateStoryboardVideo(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { force?: boolean },
  ) {
    return this.generate.generateStoryboardVideo(id, body ?? {});
  }

  // 单分镜完整生成（参考图 + 视频）
  // ==================== 分镜配音（TTS） ====================
  // 说明：TTS provider 此前已注册但从未被调用（audioUrl 只读不写），
  // 导致「合成对白音轨」开关与方言配音设置全部形同虚设。现已接通真实链路。

  @Post('storyboards/:id/generate-audio')
  generateStoryboardAudio(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { force?: boolean },
  ) {
    return this.generate.generateStoryboardAudio(id, body ?? {});
  }

  @Post('episodes/:id/generate-audio')
  generateEpisodeAudio(@Param('id', ParseIntPipe) id: number) {
    return this.generate.generateEpisodeAudio(id);
  }

  @Post('storyboards/:id/generate')
  generateStoryboard(@Param('id', ParseIntPipe) id: number) {
    return this.generate.generateStoryboardBySbId(id);
  }

  // ==================== AI 文案（描述 / 提示词 生成与丰富） ====================

  // 对角色/场景/道具/分镜的文本字段做 AI 生成或丰富润色，返回文本（不落库）
  @Post('ai/enrich')
  enrichText(@Body() body: EnrichDto) {
    return this.enrich.enrich(body ?? ({} as EnrichDto));
  }
}
