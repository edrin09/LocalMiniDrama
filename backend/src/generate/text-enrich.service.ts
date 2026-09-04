import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { AIProviderFactory } from '../ai/ai-provider.factory';

/**
 * AI 文案丰富服务：对角色/场景/道具/分镜的描述与提示词字段做「生成 / 丰富」。
 * 前端把当前输入框内容与上下文一并传来，返回润色后的文本；不直接落库，
 * 由用户在输入框中继续编辑后保存（编辑 → AI 丰富 → 再编辑的可迭代流程）。
 */

/** 每个可 AI 生成字段的任务说明 */
export const FIELD_TASKS: Record<string, string> = {
  // 角色
  appearance:
    '生成/丰富角色的外貌描述，需涵盖发型发色、五官特点、体型体态、标志性特征与整体气质，80~150 字，可直接用于 AI 生成人物立绘。',
  intro:
    '生成/丰富角色简介，涵盖身份背景、性格特点、说话风格与人物关系，100 字以内。',
  roleLabel:
    '生成/丰富角色的定位标签（如「矿区大当家」「腹黑御姐」），一句话点明身份与气质，10 字以内，直接输出标签本身。',
  // 分集
  episodeDescription:
    '生成/丰富分集简介：交代本集发生的事件、冲突与看点，吸引观众，80~150 字，直接输出简介本身。',
  // 场景 / 道具
  description:
    '生成/丰富描述，涵盖布局与外观、光线、色调、氛围与关键细节，80~150 字。',
  prompt:
    '生成/丰富生图提示词：画面主体、环境元素、构图与光线、风格关键词，80~150 字，直接输出提示词本身，不要出现「提示词：」之类的字样。',
  // 分镜
  dialogue:
    '生成/丰富该分镜的角色对白：口语化、有个性、符合人物身份与当前情绪，1~3 句，直接输出台词本身，不要旁白式叙述与引号。',
  narration:
    '生成/丰富该分镜的旁白（画外音）：简洁有叙事感，能承上启下，1~2 句。',
  sceneDescription:
    '生成/丰富本镜画面描述：画面内容、景别、构图与机位，1~3 句。',
  motionDescription:
    '生成/丰富动作与运镜描述：角色动作、表情变化与镜头运动方式，1~3 句。',
  imagePrompt:
    '生成/丰富首帧图片提示词：画面主体与场景、构图、光线与氛围，适配 9:16 竖屏构图，直接输出提示词本身。',
  videoPrompt:
    '生成/丰富分镜视频提示词：动作过程、运镜方式、画面连续性要求，适配 9:16 竖屏构图，直接输出提示词本身。',
};

export interface EnrichDto {
  /** 字段名，见 FIELD_TASKS */
  field: string;
  /** 当前输入框内容（可为空 = 全新生成） */
  content?: string;
  /** 项目上下文（剧名/分集/角色/场景等，前端拼好传入） */
  context?: string;
  /** 用户补充要求 */
  instruction?: string;
}

@Injectable()
export class TextEnrichService {
  private readonly logger = new Logger(TextEnrichService.name);

  constructor(private readonly factory: AIProviderFactory) {}

  async enrich(dto: EnrichDto): Promise<{ text: string }> {
    const task = FIELD_TASKS[dto.field];
    if (!task) throw new BadRequestException(`不支持的字段：${dto.field}`);
    if (!this.factory.isLive('text')) {
      throw new BadRequestException(
        '未配置文本模型（AGNES_API_KEY），无法使用 AI 生成文案',
      );
    }

    const current = (dto.content || '').trim();
    const prompt = [
      '你是短剧剧本策划助手，正在帮助创作者编写漫剧的角色、场景与分镜文案。',
      dto.context?.trim() ? `项目背景信息：\n${dto.context.trim()}` : '',
      `任务：${task}`,
      current
        ? `创作者已写下的内容（请在此基础上丰富润色，保留其设定与原意，不要推翻）：\n${current}`
        : '当前内容为空，请根据背景信息直接生成。',
      dto.instruction?.trim()
        ? `用户补充要求：${dto.instruction.trim()}`
        : '',
      '输出要求：直接输出结果文本本身，不要任何解释、前缀、引号或 Markdown 标记。',
    ]
      .filter(Boolean)
      .join('\n\n');

    const provider = this.factory.resolve('text');
    const res = await provider.generate('text', {
      prompt,
      options: { temperature: 0.7, maxTokens: 800 },
    });

    let text = (res.text || '')
      .trim()
      // 去掉模型偶尔包裹的引号
      .replace(/^[「『"'“”]+/, '')
      .replace(/[」』"'“”]+$/, '')
      .trim();
    // 去掉常见的「提示词：」「旁白：」等前缀
    text = text.replace(/^(提示词|文案|内容|结果|旁白|对白|描述)[:：]\s*/i, '');
    if (!text) {
      this.logger.warn(`AI 文案生成返回空结果（field=${dto.field}）`);
      throw new BadRequestException('AI 未返回内容，请重试');
    }
    return { text };
  }
}
