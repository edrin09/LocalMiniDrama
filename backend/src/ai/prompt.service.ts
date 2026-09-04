import { Injectable, Logger } from '@nestjs/common';
import { AIProviderFactory } from './ai-provider.factory';

// 提示词构建与角色视觉锚点（开发文档 §4.1 / §4.4）
// 跨分镜一致性 = 首帧图内注入锚点 + 尾帧衔接，不再依赖多图参考排序。

/** 全剧统一美术风格锚点 */
export const STYLE_ANCHOR =
  '国产可爱动画风格，中国人（东亚人种）形象，自然浅肤色，干净线条，柔和打光';

/** 服饰词需剔除：锁定核心面部与发型，避免跨分镜衣服漂移 */
const CLOTHING_PATTERN =
  /(Wearing|Dressed in|wearing|dressed in|穿着|身穿|身着|上衣|裤子|裙子|连衣裙|西装|T恤|外套|鞋子|帽子|服饰)[^,，。;；]*/g;

export interface CharacterLike {
  name: string;
  role?: string | null;
  roleLabel?: string | null;
  appearance?: string | null;
  anchors?: string | null;
  intro?: string | null;
}

export interface SceneLike {
  location: string;
  time?: string | null;
  description?: string | null;
  prompt?: string | null;
}

export interface PropLike {
  name: string;
  type?: string | null;
  description?: string | null;
  prompt?: string | null;
}

export interface StoryboardLike {
  number: number;
  dialogue?: string | null;
  narration?: string | null;
  sceneDescription?: string | null;
  motionDescription?: string | null;
  emotion?: string | null;
  duration?: number | null;
  imagePrompt?: string | null;
  videoPrompt?: string | null;
}

/** 全剧统一生成一致性配置（来自分集 genCfg，缺省走默认值） */
export interface GenStyle {
  /** 音轨/字幕语言：zh-CN 中文普通话（默认） */
  language?: string;
  /** 是否允许唱词（默认 false = 禁止唱歌，保证全剧一致） */
  allowSinging?: boolean;
}

/** 语言一致性约束：注入生图/生视频提示词，杜绝外语/乱码语音 */
export function languageConstraint(style?: GenStyle): string {
  const lang = style?.language || 'zh-CN';
  if (lang === 'zh-CN') {
    return '画面中出现的台词、字幕、文字必须为中文普通话，禁止外语、乱码、非中文发音';
  }
  return `画面中出现的台词、字幕、文字必须使用指定语言（${lang}），保持全片一致`;
}

/** 唱词一致性约束：默认禁止唱歌，保证各分镜音轨统一 */
export function singingConstraint(style?: GenStyle): string {
  if (style?.allowSinging) {
    return '允许唱词，但歌词必须为中文普通话，且全片唱词风格保持一致';
  }
  return '禁止唱歌、禁止哼唱、禁止演唱、禁止配乐歌词，画面人物不得歌唱';
}

@Injectable()
export class PromptService {
  private readonly logger = new Logger(PromptService.name);

  constructor(private readonly factory: AIProviderFactory) {}

  // ==================== 视觉锚点 ====================

  /** 剔除服饰词，锁定面部与发型 */
  stripClothing(text: string): string {
    return (text || '')
      .replace(CLOTHING_PATTERN, '')
      .replace(/[，,]\s*(?=[，,])/g, '')
      .replace(/\s{2,}/g, ' ')
      .replace(/^[，,、\s]+|[，,、\s]+$/g, '')
      .trim();
  }

  /**
   * 提炼 6 层视觉锚点：优先文本模型润色，失败则本地规则兜底。
   * 返回可直接注入提示词的自然语言锚点串。
   */
  async buildCharacterAnchorText(c: CharacterLike): Promise<string> {
    const base = this.stripClothing(c.appearance || '');
    if (!base) return STYLE_ANCHOR;

    if (this.factory.isLive('text')) {
      try {
        const provider = this.factory.resolve('text');
        const res = await provider.generate('text', {
          prompt:
            `把以下角色外貌描述整理为 6 层视觉锚点（面部轮廓 / 发型发色 / 五官细节 / 体型体态 / 主色配色 / 标志性气质），` +
            `去除所有服饰与临时装饰词，只保留跨镜头必须保持一致的特征。` +
            `每行一条，格式「层名：描述」，不要多余解释。\n\n角色：${c.name}\n外貌：${base}`,
        });
        if (res.text && res.text.length > 10) {
          return `${STYLE_ANCHOR}；${res.text.replace(/\n+/g, '；').trim()}`;
        }
      } catch (e: any) {
        this.logger.warn(`锚点提炼失败，使用本地兜底：${e.message}`);
      }
    }
    return `${STYLE_ANCHOR}；${base}`;
  }

  // ==================== 素材提示词 ====================

  characterImagePrompt(c: CharacterLike): string {
    const anchors = c.anchors || this.stripClothing(c.appearance || '');
    const parts = [
      STYLE_ANCHOR,
      `角色名：${c.name}`,
      c.roleLabel ? `身份定位：${c.roleLabel}` : '',
      anchors ? `外貌锚点：${anchors}` : '',
      '竖版人物立绘，居中构图，半身像，纯色简洁背景，高细节',
    ].filter(Boolean);
    return parts.join('，');
  }

  sceneImagePrompt(s: SceneLike, quad: boolean): string {
    const body = [
      s.prompt?.trim(),
      s.description?.trim(),
      `${s.location}${s.time ? `，${s.time}` : ''}`,
    ]
      .filter(Boolean)
      .join('；');
    const base = `${STYLE_ANCHOR}，场景概念图，${body}，电影级构图，环境光自然，高视觉密度`;
    if (!quad) return `${base}，单张完整场景图，无人物或仅远景小人物`;
    return (
      `${base}，四宫格分镜参考图：2x2 排列，四个格子分别为同一场景的正面平视、侧面平视、俯视、仰视四个视角，` +
      `保持场景元素与色调完全一致，格与格之间留白色细分隔线，无文字标注`
    );
  }

  propImagePrompt(p: PropLike, quad: boolean): string {
    const body = [p.prompt?.trim(), p.description?.trim(), `${p.name}${p.type ? `（${p.type}）` : ''}`]
      .filter(Boolean)
      .join('；');
    const base = `${STYLE_ANCHOR}，道具设定图，${body}，纯色无缝背景，主体居中，清晰轮廓，高细节`;
    if (!quad) return base;
    return (
      `${base}，四视图道具图：2x2 排列，分别为正面、侧面、背面、45度斜视角四个视图，` +
      `纯色无缝背景，比例与材质一致，格与格之间留白色细分隔线，无文字标注`
    );
  }

  // ==================== 分镜提示词 ====================

  /**
   * 分镜首帧：把角色锚点 + 场景 + 道具全部注入画面内，
   * 靠这张图保证后续视频里的人物一致性。
   */
  storyboardImagePrompt(
    ctx: {
      sb: StoryboardLike;
      character?: CharacterLike | null;
      scene?: SceneLike | null;
      prop?: PropLike | null;
    },
    style?: GenStyle,
  ): string {
    const { sb, character, scene, prop } = ctx;
    const custom = sb.imagePrompt?.trim();
    const composed = [
      STYLE_ANCHOR,
      character
        ? `画面主体角色：${character.name}，${character.anchors || this.stripClothing(character.appearance || '')}`
        : '画面无人物主体，纯环境与氛围',
      scene
        ? `场景：${scene.location}${scene.time ? `，${scene.time}` : ''}${scene.description ? `，${scene.description}` : ''}`
        : '',
      sb.sceneDescription?.trim() ? `画面描述：${sb.sceneDescription.trim()}` : '',
      sb.motionDescription?.trim() ? `动作描述：${sb.motionDescription.trim()}` : '',
      prop ? `画面中出现道具：${prop.name}${prop.description ? `，${prop.description}` : ''}` : '',
      sb.dialogue ? `人物正在说：「${sb.dialogue}」` : '',
      sb.narration ? `画面氛围对应旁白：${sb.narration}` : '',
      EMOTION_HINT[sb.emotion || ''] ?? '',
      languageConstraint(style),
      '电影级构图，主体清晰，适合作为视频首帧，高细节',
    ].filter(Boolean);

    return custom ? `${custom}；${composed.join('，')}` : composed.join('，');
  }

  /** 尾帧：与首帧同一场景与人物，呈现动作后的结束状态 */
  storyboardLastFramePrompt(ctx: {
    sb: StoryboardLike;
    character?: CharacterLike | null;
    scene?: SceneLike | null;
  }): string {
    const { sb, character, scene } = ctx;
    return [
      STYLE_ANCHOR,
      character
        ? `同一角色：${character.name}，${character.anchors || this.stripClothing(character.appearance || '')}，面部与发型必须与参考图完全一致`
        : '同一环境，无人物主体',
      scene ? `同一场景：${scene.location}` : '',
      sb.dialogue ? `对白「${sb.dialogue}」说完后的收尾姿态` : '镜头自然收束的结束状态',
      '与参考图为同一场景同一人物，仅姿态与镜头推进发生变化，构图稳定，高细节',
    ]
      .filter(Boolean)
      .join('，');
  }

  /** 视频提示词：硬约束要求人物外貌整段不变，并统一音轨语言与唱词 */
  videoPrompt(
    ctx: {
      sb: StoryboardLike;
      character?: CharacterLike | null;
      scene?: SceneLike | null;
    },
    style?: GenStyle,
  ): string {
    const { sb, character, scene } = ctx;
    const custom = sb.videoPrompt?.trim();
    const composed = [
      character
        ? `硬约束：画面中的${character.name}的面部、发型、体型与服装在整段视频中保持完全不变，不得换脸、不得变形`
        : '硬约束：画面构图与场景元素在整段视频中保持稳定',
      character ? `角色外貌：${character.anchors || this.stripClothing(character.appearance || '')}` : '',
      scene ? `场景：${scene.location}${scene.time ? `，${scene.time}` : ''}` : '',
      sb.sceneDescription?.trim() ? `画面描述：${sb.sceneDescription.trim()}` : '',
      sb.motionDescription?.trim() ? `动作与运镜：${sb.motionDescription.trim()}` : '',
      sb.narration || sb.dialogue || '镜头自然推进，轻微运动',
      EMOTION_HINT[sb.emotion || ''] ?? '',
      languageConstraint(style),
      singingConstraint(style),
      '构图约束：竖屏 9:16 满屏人像构图，禁止横屏/宽幅/分屏/16:9',
      '镜头稳定，电影级运镜，画面连贯不跳切',
    ].filter(Boolean);
    return custom ? `${custom}；${composed.join('，')}` : composed.join('，');
  }

  // ==================== 参考图描述提取 ====================

  /** 参考图描述提取任务（角色外貌 / 场景 / 道具） */
  private static readonly DESCRIBE_TASKS: Record<
    'character' | 'scene' | 'prop',
    string
  > = {
    character:
      '请观察这张人物参考图，提取外貌特征：性别与年龄段、发型发色、五官特点、体型体态、整体气质；忽略服饰与背景。输出一段 80 字以内的中文外貌描述，可直接用于 AI 生成人物形象，不要任何前缀和解释。',
    scene:
      '请观察这张场景参考图，提取场景信息：地点类型、时间与光线、主要环境元素、色调与氛围。输出一段 80 字以内的中文场景描述，可直接用于 AI 生成场景图，不要任何前缀和解释。',
    prop:
      '请观察这张道具参考图，提取道具信息：外观形态、颜色与材质、细节特征、用途线索。输出一段 80 字以内的中文道具描述，可直接用于 AI 生成道具图，不要任何前缀和解释。',
  };

  /**
   * 从参考图提取描述（角色外貌 / 场景描述 / 道具描述）。
   * 文本模型未配置或调用失败时返回 null，由前端提示手动填写。
   */
  async describeImage(
    dataUri: string,
    kind: 'character' | 'scene' | 'prop',
  ): Promise<string | null> {
    if (!this.factory.isLive('text')) {
      this.logger.warn('文本模型未配置 Key，无法提取参考图描述');
      return null;
    }
    try {
      const provider = this.factory.resolve('text');
      const res = await provider.generate('text', {
        prompt: PromptService.DESCRIBE_TASKS[kind],
        options: {
          images: [dataUri],
          temperature: 0.3,
          maxTokens: 300,
        },
      });
      const text = (res.text || '').trim();
      return text.length > 0 ? text : null;
    } catch (e: any) {
      this.logger.warn(`参考图描述提取失败：${e.message}`);
      return null;
    }
  }

  /**
   * 旋转检测：AI 视频偶发把像素旋转 90°，但容器元数据仍写 portrait。
   * 用首帧参考图（朝向正确）与视频抽出的首帧做对比，让文本模型回答是否被旋转。
   * 返回 0（不旋转）/ 1（顺时针 90°）/ 2（逆时针 90°）。
   * 模型未配置或调用失败时返回 0（默认不旋转，让原问题暴露给人工处理）。
   */
  async detectRotation(refUri: string, frameUri: string): Promise<0 | 1 | 2> {
    if (!this.factory.isLive('text')) {
      this.logger.warn('文本模型未配置 Key，跳过旋转检测');
      return 0;
    }
    try {
      const provider = this.factory.resolve('text');
      const res = await provider.generate('text', {
        prompt:
          '对比这两张图：第一张是参考图（朝向正确）；第二张可能相对第一张被旋转了 90°。' +
          '判断第二张相对第一张是「同向 / 顺时针 90° / 逆时针 90°」。' +
          '只输出一个英文单词：same 或 cw 或 ccw。不要任何解释或标点。',
        options: {
          images: [refUri, frameUri],
          temperature: 0,
          maxTokens: 5,
        },
      });
      const t = (res.text || '').trim().toLowerCase();
      if (t.startsWith('cw')) return 1;
      if (t.startsWith('ccw')) return 2;
      return 0;
    } catch (e: any) {
      this.logger.warn(`旋转检测失败，默认不旋转：${e.message}`);
      return 0;
    }
  }
}

const EMOTION_HINT: Record<string, string> = {
  happy: '情绪：开心，面带笑容',
  sad: '情绪：悲伤，神情低落',
  angry: '情绪：愤怒，眉头紧皱',
  fear: '情绪：恐惧，神情紧张',
  surprise: '情绪：惊讶，睁大眼睛',
  neutral: '情绪：平静',
};
