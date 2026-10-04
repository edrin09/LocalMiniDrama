import { Injectable, Logger } from '@nestjs/common';
import { AIProviderFactory } from './ai-provider.factory';

// 提示词构建与角色视觉锚点（开发文档 §4.1 / §4.4）
// 跨分镜一致性 = 首帧图内注入锚点 + 尾帧衔接，不再依赖多图参考排序。

/**
 * 全局画面风格体系（genCfg.artStyle）。
 * 风格词必须「够具体 + 带排除项」：只写「可爱动画」这类弱词时，
 * 生图/生视频模型会自由发挥成 3D 或写实真人，导致全剧风格漂移。
 */
export const ART_STYLES: Record<string, { label: string; anchor: string }> = {
  cartoon: {
    label: '2D 卡通动漫',
    anchor:
      '2D卡通动漫风格，日系赛璐璐动画质感，清晰干净的线条描边，明亮大眼，扁平色块上色，柔和阴影，色彩明快饱和，非写实真人、非3D渲染、非照片质感',
  },
  anime2d: {
    label: '日系二维动画',
    anchor:
      '日系二维动画风格，赛璐璐上色，精致线稿，动漫比例大眼，柔和渐变光影，非写实真人、非3D渲染',
  },
  anime3d: {
    label: '3D 动画电影',
    anchor:
      '3D动画电影风格，皮克斯质感，圆润角色建模，卡通渲染三转二着色，柔和全局光照，非写实真人',
  },
  realistic: {
    label: '写实真人',
    anchor:
      '写实真人电影质感，自然光影，真实皮肤与材质细节，电影级摄影，浅景深',
  },
  watercolor: {
    label: '国风水墨',
    anchor:
      '中国风水墨动画风格，水墨晕染笔触，留白构图，淡彩点染，意境悠远',
  },
};

/** 按风格配置取风格锚点（未知值回退卡通，即用户默认要的「卡通人物」） */
export function styleAnchorOf(style?: GenStyle): string {
  const key = style?.artStyle;
  return (key && ART_STYLES[key]?.anchor) || ART_STYLES.cartoon.anchor;
}

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

/**
 * 参考图声明项：随请求附上的每张参考图及其角色。
 * index 为 1-based 序号（Agnes 官方约定「第一个图 = 主体」）。
 */
export interface ImageRef {
  kind: 'character' | 'scene' | 'prop' | 'tail';
  /** 角色名 / 场景地点 / 道具名 / '上一镜尾帧' */
  name: string;
  /** 仅内部计算时使用，由提示词构建按顺序填充 */
  index?: number;
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
  /** 画面风格：cartoon（默认）| anime2d | anime3d | realistic | watercolor */
  artStyle?: string;
}

/** 锚点内嵌的风格标记：切换风格后自动触发锚点重建；a2 = 保留服饰的锚点版本 */
export function anchorStyleTag(style?: GenStyle): string {
  return `【风格:${style?.artStyle || 'cartoon'}|a2】`;
}

/**
 * 剥离锚点里的程序内部标记（形如 【风格:cartoon|a2】）。
 * 这些标记只用于「锚点是否需要按当前风格重建」的程序判断，
 * 绝不能进入送给生图模型的提示词——模型会把方括号内容当成画面元素或乱码文字去渲染。
 */
export function stripAnchorMeta(text?: string | null): string {
  return (text || '')
    .replace(/【[^】]{0,40}】/g, '')
    .replace(/^[；;，,、\s]+/, '')
    .replace(/；{2,}/g, '；')
    .trim();
}

/** 归一化标点与空白，用于「包含关系」比较（避免全角/半角差异导致漏判） */
function normForCompare(s: string): string {
  return s.replace(/[，,。、；;：:\s·・]/g, '');
}

/**
 * 剔除锚点里与全局风格锚点重复的部分。
 * 锚点以「角色特征」为唯一职责，画面风格由 styleAnchorOf() 统一注入；
 * 若不剔除，同一段风格词会在提示词里出现两次，白白稀释人物特征的权重，
 * 也让「切换风格」时锚点里残留旧风格词、把新风格带偏（旧数据全部命中此路径）。
 *
 * 判据是「归一化后的公共前缀」：历史锚点里的风格片段几乎总是全局风格锚点的
 * 前若干个逗号分句（如「2D卡通动漫风格，日系赛璐璐动画质感，明亮大眼」），
 * 中间会跳过若干分句，因此它既不是 styleAnchor 的子串、styleAnchor 也不是它的子串
 * —— 只做 contains 双向判断会漏判，风格词根本没被剔除。
 * 这里改判前缀重合度：片段开头与风格锚点开头重合达 6 个字符以上即视为风格词。
 * 剔除后若结果为空则回退原文，宁可重复也不丢人物特征。
 */
export function dedupeStyleAnchor(text: string, style?: GenStyle): string {
  const raw = (text || '').trim();
  if (!raw) return '';
  const styleAnchor = normForCompare(styleAnchorOf(style));
  if (styleAnchor.length < 8) return raw;
  const kept = raw
    .split(/[；;\n]/)
    .filter((seg) => {
      const n = normForCompare(seg);
      if (n.length < 4) return true; // 太短的片段（如「黑短发」）不参与判定
      let prefix = 0;
      while (
        prefix < n.length &&
        prefix < styleAnchor.length &&
        n[prefix] === styleAnchor[prefix]
      ) {
        prefix += 1;
      }
      const isStyle = prefix >= 6 || n.includes(styleAnchor);
      return !isStyle;
    })
    .join('；')
    .replace(/^[；;，,、\s]+/, '')
    .replace(/[；;，,、\s]+$/, '')
    .trim();
  return kept || raw;
}

/** 语言一致性约束（针对音轨与口型，覆盖角色对白与旁白，不再提及“画面文字”，避免诱导模型烧字） */
export function languageConstraint(style?: GenStyle): string {
  const lang = style?.language || 'zh-CN';
  if (lang === 'zh-CN') {
    return '本镜所有语音（角色对白、旁白口播）必须用标准中文普通话清晰朗读，口型与中文语音匹配，禁止英语、方言或外语发音';
  }
  return `本镜所有语音（角色对白、旁白口播）必须使用指定语言（${lang}）朗读，口型与语音匹配，保持全片一致`;
}

/** 唱词一致性约束：默认禁止唱歌，保证各分镜音轨统一 */
export function singingConstraint(style?: GenStyle): string {
  if (style?.allowSinging) {
    return '允许唱词，但歌词必须为中文普通话，且全片唱词风格保持一致';
  }
  return '禁止唱歌、禁止哼唱、禁止演唱、禁止配乐歌词，画面人物不得歌唱';
}

/** 首帧一致性自动审核结果 */
export interface FirstFrameAudit {
  pass: boolean;
  issues: string[];
  /** 模型原始判定（如 A=no B=yes），用于日志排查 */
  reasons: string[];
}

@Injectable()
export class PromptService {
  private readonly logger = new Logger(PromptService.name);

  constructor(private readonly factory: AIProviderFactory) {}

  // ==================== 视觉锚点 ====================

  /**
   * 提炼角色视觉锚点：优先文本模型润色，失败则用外貌原文兜底。
   * 服饰与标志性配饰（帽子/眼镜等）是跨分镜一致性的关键，必须保留——
   * 之前把服饰词剔除导致立绘与分镜帧服装各自漂移（蓝马甲→灰盔甲）。
   * 返回可直接注入提示词的自然语言锚点串（头部带风格标记与风格锚点）。
   */
  async buildCharacterAnchorText(
    c: CharacterLike,
    style?: GenStyle,
  ): Promise<string> {
    const anchor = styleAnchorOf(style);
    const tag = anchorStyleTag(style);
    const base = (c.appearance || '').trim();
    if (!base) return `${tag}${anchor}`;

    if (this.factory.isLive('text')) {
      try {
        const provider = this.factory.resolve('text');
        const res = await provider.generate('text', {
          prompt:
            `把以下角色外貌描述整理为 6 层视觉锚点（面部轮廓 / 发型发色 / 五官细节 / 体型体态 / 服装与主色配色 / 标志性配饰与气质）。` +
            `服装（颜色与款式）和标志性配饰（帽子、眼镜、饰品等）是角色跨镜头身份识别的一部分，必须原样保留、不得省略或改写颜色。` +
            `每行一条，格式「层名：描述」，不要多余解释。\n\n角色：${c.name}\n外貌：${base}`,
        });
        if (res.text && res.text.length > 10) {
          return `${tag}${anchor}；${res.text.replace(/\n+/g, '；').trim()}`;
        }
      } catch (e: any) {
        this.logger.warn(`锚点提炼失败，使用本地兜底：${e.message}`);
      }
    }
    return `${tag}${anchor}；${base}`;
  }

  /** 按形象图实际内容生成锚点（生成后回读，保证锚点与立绘完全一致） */
  anchorFromDescription(desc: string, style?: GenStyle): string {
    const text = (desc || '').trim();
    if (!text) return '';
    return `${anchorStyleTag(style)}${styleAnchorOf(style)}；${text}`;
  }

  /**
   * 角色锚点文案（注入提示词用）。
   * 锚点缺失时回退外貌原文（含服饰），并统一做两件事：
   * ① 剥离程序内部标记【风格:…】；② 剔除与全局风格锚点重复的片段。
   * 两者都不做的话，生图提示词里会同时出现乱码标记和重复的风格词，
   * 稀释人物特征权重 —— 这正是「角色统一化做得很烂」的直接原因之一。
   */
  anchorTextOf(c: CharacterLike, style?: GenStyle): string {
    const raw = (c.anchors || c.appearance || '').trim();
    if (!raw) return '';
    return dedupeStyleAnchor(stripAnchorMeta(raw), style);
  }

  // ==================== 素材提示词 ====================

  characterImagePrompt(c: CharacterLike, style?: GenStyle): string {
    const anchors = this.anchorTextOf(c, style);
    const parts = [
      styleAnchorOf(style),
      `角色名：${c.name}`,
      c.roleLabel ? `身份定位：${c.roleLabel}` : '',
      anchors ? `外貌与服装锚点：${anchors}` : '',
      '竖版人物立绘，居中构图，半身像，服装颜色与款式清晰完整，纯色简洁背景，高细节',
      '画面中不出现任何文字、水印',
    ].filter(Boolean);
    return parts.join('，');
  }

  sceneImagePrompt(
    s: SceneLike,
    quad: boolean,
    style?: GenStyle,
    charCtx?: string,
  ): string {
    const body = [
      s.prompt?.trim(),
      s.description?.trim(),
      `${s.location}${s.time ? `，${s.time}` : ''}`,
    ]
      .filter(Boolean)
      .join('；');
    // 角色名词歧义消解：蛋蛋这类昵称必须明确是「人名」而非「物体」，防止场景图把角色渲染成同名实物
    const disamb = charCtx
      ? `。以下是本剧角色的人名/昵称（仅用于指代人物，不是物体名词，绝不可把它们画成鸡蛋/物件等同名实物）：${charCtx}`
      : '';
    const base = `${styleAnchorOf(style)}，场景概念图，${body}${disamb}，电影级构图，环境光自然，高视觉密度，画面中不出现任何文字、水印`;
    if (!quad) return `${base}，单张完整场景图，无人物或仅远景小人物`;
    return (
      `${base}，四宫格分镜参考图：2x2 排列，四个格子分别为同一场景的正面平视、侧面平视、俯视、仰视四个视角，` +
      `保持场景元素与色调完全一致，格与格之间留白色细分隔线，无文字标注`
    );
  }

  propImagePrompt(p: PropLike, quad: boolean, style?: GenStyle, charCtx?: string): string {
    const body = [p.prompt?.trim(), p.description?.trim(), `${p.name}${p.type ? `（${p.type}）` : ''}`]
      .filter(Boolean)
      .join('；');
    // 同上：道具名/描述若与角色昵称相同，必须按人消歧，勿画成同名实物
    const disamb = charCtx
      ? `。注意：以下本剧角色的人名/昵称是人物，不是实物（如「蛋蛋」是人不是鸡蛋），道具设定图若含上述字词一律按人物处理，不得画成同名物体：${charCtx}`
      : '';
    const base = `${styleAnchorOf(style)}，道具设定图，${body}${disamb}，纯色无缝背景，主体居中，清晰轮廓，高细节，画面中不出现任何文字、水印`;
    if (!quad) return base;
    return (
      `${base}，四视图道具图：2x2 排列，分别为正面、侧面、背面、45度斜视角四个视图，` +
      `纯色无缝背景，比例与材质一致，格与格之间留白色细分隔线，无文字标注`
    );
  }

  // ==================== 分镜提示词 ====================

  /**
   * 分镜首帧：把角色锚点（含服装）+ 场景 + 道具全部注入画面内，
   * 靠这张图保证后续视频里的人物一致性。
   * - 服装颜色与款式显式锁定到角色形象参考图（此前只锁面部/发型，服装随意漂移）
   * - refs：随请求附上的参考图及其角色（按顺序，1-based），用于按官方四段式声明图间关系
   * 注意：台词绝不以文字形式出现在画面里（画字=乱码），只描述说话神态。
   */
  storyboardImagePrompt(
    ctx: {
      sb: StoryboardLike;
      character?: CharacterLike | null;
      characters?: CharacterLike[] | null;
      scene?: SceneLike | null;
      prop?: PropLike | null;
      props?: PropLike[] | null;
      refNames?: string[] | null;
      refs?: ImageRef[] | null;
      hasTailRef?: boolean;
    },
    style?: GenStyle,
  ): string {
    const { sb, character, characters, scene, prop, props, refNames, refs, hasTailRef } =
      ctx;
    const custom = sb.imagePrompt?.trim();

    // 归一化角色列表：优先 characters，回退单值 character
    const charList: CharacterLike[] = characters?.length
      ? characters
      : character
        ? [character]
        : [];
    const propList: PropLike[] = props?.length ? props : prop ? [prop] : [];
    const refNameList = refNames || [];
    // 权威参考图声明：有 refs 用 refs（含场景/道具/尾帧），否则回退旧的 refNames
    const refList: ImageRef[] = (refs && refs.length > 0
      ? refs
      : refNameList.map((name) => ({ kind: 'character' as const, name }))
    ).map((r, i) => ({ ...r, index: i + 1 }));

    // 角色主体描述：多角色逐个锁定；服装与配色必须与形象参考图一致。
    // 关键：多角色同框时必须显式锁定「画面里恰好有几个人」并禁止特征互串，
    // 否则模型会把两人画成一个人（特征平均化）或张冠李戴（甲穿乙的衣服）。
    const charDesc = charList.length
      ? [
          charList.length > 1
            ? `画面中恰好有 ${charList.length} 个人物，每位人物各自独立、互不融合，禁止把不同角色的五官或服装特征混到同一个人身上，禁止多画或少画人物`
            : '画面中恰好有 1 个人物',
          // MSR 论文指认的最高危失败模式：服装相近 → 参考图混淆 / 特征平均化。
          // 零成本对策：显式要求各角色服装主色互斥。
          charList.length > 1
            ? '服装配色要求：各角色的服装主色必须彼此明显不同，禁止两人服装颜色或款式相近'
            : '',
          charList
            .map((c, i) => {
              const ref = refList.find(
                (r) => r.kind === 'character' && r.name === c.name,
              );
              const refNote = ref ? `（其形象立绘为参考图第 ${ref.index} 张）` : '';
              const roleNote =
                charList.length > 1 ? `画面中第 ${i + 1} 位人物，` : '';
              return (
                `${roleNote}即角色「${c.name}」：${this.anchorTextOf(c, style)}，` +
                `其面部五官、发型发色、体型以及服装的颜色与款式必须与其形象参考图完全一致，不得更换服装、不得改变服装颜色${refNote}`
              );
            })
            .join('；'),
        ]
          .filter(Boolean)
          .join('；')
      : '画面无人物主体，纯环境与氛围';

    const propDesc = propList.length
      ? `画面中出现道具：${propList
          .map((p) => `${p.name}${p.description ? `（${p.description}）` : ''}`)
          .join('、')}`
      : '';

    // 官方四段式之「图间关系」：显式说明每张参考图的角色与排序。
    // 缺失这一段时模型容易把场景图当人物、或把尾帧当主体（reference confusion）。
    const refNote = this.referenceRelationNote(refList, {
      sceneLocation: scene?.location,
      hasTailRef,
    });

    const composed = [
      styleAnchorOf(style),
      charDesc,
      scene
        ? `场景：${scene.location}${scene.time ? `，${scene.time}` : ''}${scene.description ? `，${scene.description}` : ''}`
        : '',
      sb.sceneDescription?.trim() ? `画面描述：${sb.sceneDescription.trim()}` : '',
      sb.motionDescription?.trim() ? `动作描述：${sb.motionDescription.trim()}` : '',
      propDesc,
      sb.dialogue ? '角色正在张口说话的神态与表情（画面中不出现台词文字）' : '',
      sb.narration ? `画面氛围：${sb.narration}` : '',
      EMOTION_HINT[sb.emotion || ''] ?? '',
      '画面中严禁出现任何文字、字幕、对话气泡、水印、招牌字',
      '电影级构图，主体清晰，适合作为视频首帧，高细节',
    ]
      .filter(Boolean)
      .concat(refNote ? [refNote] : []);

    return custom ? `${custom}；${composed.join('，')}` : composed.join('，');
  }

  /**
   * 参考图「图间关系」声明（Agnes 官方多图推荐结构的第三段）。
   * 按官方示例「第一个图 = 主体」组织：角色立绘在前，场景/道具/尾帧在后。
   */
  private referenceRelationNote(
    refs: ImageRef[],
    opt: { sceneLocation?: string; hasTailRef?: boolean } = {},
  ): string {
    if (refs.length === 0) return '';
    const parts = refs.map((r) => {
      switch (r.kind) {
        case 'character':
          return `第${r.index}张为角色「${r.name}」的形象立绘`;
        case 'scene':
          return `第${r.index}张为场景「${r.name}」的参考图`;
        case 'prop':
          return `第${r.index}张为道具「${r.name}」的参考图`;
        case 'tail':
          return `第${r.index}张为上一镜的画面衔接参考（非人物立绘）`;
        default:
          return `第${r.index}张为参考图`;
      }
    });
    const rule = [
      '参考图按所附顺序编号，以下各图的角色与相互关系为：',
      parts.join('；'),
      refs.some((r) => r.kind === 'character')
        ? '以第1张图的人物为主体，其余图片仅用于约束空间、道具与镜头连续性，不得把场景图或道具图里的人物混入主体'
        : '',
      opt.hasTailRef ? '尾帧参考图仅用于保持与上一镜的画面连续，不得照搬其人物身份' : '',
    ]
      .filter(Boolean)
      .join('；');
    return rule;
  }

  /** 尾帧：与首帧同一场景与人物（含服装），呈现动作后的结束状态 */
  storyboardLastFramePrompt(
    ctx: {
      sb: StoryboardLike;
      character?: CharacterLike | null;
      characters?: CharacterLike[] | null;
      scene?: SceneLike | null;
    },
    style?: GenStyle,
  ): string {
    const { sb, character, characters, scene } = ctx;
    const charList: CharacterLike[] = characters?.length
      ? characters
      : character
        ? [character]
        : [];
    const charDesc = charList.length
      ? [
          charList.length > 1
            ? `画面中仍是同样的 ${charList.length} 个人物，位置与人数不变，禁止把不同角色的五官或服装特征混到同一个人身上`
            : '画面中仍是同一个人物',
          charList
            .map(
              (c) =>
                `同一角色「${c.name}」：${this.anchorTextOf(c, style)}，面部、发型、体型以及服装的颜色与款式必须与首帧保持完全一致`,
            )
            .join('；'),
        ].join('；')
      : '同一环境，无人物主体';
    return [
      styleAnchorOf(style),
      charDesc,
      scene ? `同一场景：${scene.location}` : '',
      sb.dialogue ? '对白说完后的收尾姿态与神态' : '镜头自然收束的结束状态',
      '与首帧为同一场景同一人物，服装颜色与款式不变，仅姿态与镜头推进发生变化，构图稳定，高细节',
      '画面中严禁出现任何文字、字幕、对话气泡、水印',
    ]
      .filter(Boolean)
      .join('，');
  }

  /**
   * 视频提示词：画面由首帧(keyframe)或参考图(reference)锁定，
   * 文本只负责「动作 + 运镜 + 台语言语」——塞太多约束反而稀释关键指令。
   * - keyframe 模式：首帧已锁定画面，不再重复外貌长串
   * - reference 模式：用 <Picture N> 指代角色形象参考图
   * - text 模式：无图可依，注入外貌锚点兜底
   * 旁白不进视频提示词（留给后期配音/字幕），只有对白作为口播台词。
   */
  videoPrompt(
    ctx: {
      sb: StoryboardLike;
      character?: CharacterLike | null;
      characters?: CharacterLike[] | null;
      scene?: SceneLike | null;
    },
    style?: GenStyle,
    refNames: string[] = [],
  ): string {
    const { sb, character, characters, scene } = ctx;
    const custom = sb.videoPrompt?.trim();
    const charList: CharacterLike[] = characters?.length
      ? characters
      : character
        ? [character]
        : [];

    // 锁定约束：三种模式各写各的，避免重复堆叠
    let lock: string;
    if (refNames.length > 0) {
      lock =
        `硬约束：画面中恰好 ${charList.length} 个人物，全程人数与身份不变，禁止多人互相融合或特征互串；` +
        charList
          .map((c, i) => {
            const pic = i < refNames.length ? `<Picture ${i + 1}>` : '';
            return `${pic}是角色「${c.name}」的形象参考，其面部、发型、体型与服装在整段视频中与参考完全一致，不得换脸、不得变形`;
          })
          .join('；');
    } else if (charList.length > 0) {
      lock =
        `硬约束：画面中恰好 ${charList.length} 个人物，全程人数与身份不变，禁止多人互相融合或特征互串；` +
        charList
          .map((c) => `${c.name}的面部、发型、体型与服装在整段视频中保持完全不变，不得换脸、不得变形`)
          .join('；') +
        `；角色外貌：${charList.map((c) => `${c.name}（${this.anchorTextOf(c, style)}）`).join('；')}`;
    } else {
      lock = '硬约束：画面构图与场景元素在整段视频中保持稳定';
    }

    const composed = [
      lock,
      scene ? `场景：${scene.location}${scene.time ? `，${scene.time}` : ''}` : '',
      sb.sceneDescription?.trim() ? `画面：${sb.sceneDescription.trim()}` : '',
      sb.motionDescription?.trim() ? `动作与运镜：${sb.motionDescription.trim()}` : '',
      sb.dialogue
        ? `角色台词（口播）：「${sb.dialogue}」`
        : sb.narration?.trim()
          ? `旁白口播（标准中文普通话，作为画外音男声清晰朗读）：「${sb.narration.trim()}」`
          : '镜头自然推进，轻微运动',
      EMOTION_HINT[sb.emotion || ''] ?? '',
      languageConstraint(style),
      singingConstraint(style),
      '竖屏 9:16 满幅构图，禁止横屏、宽幅、分屏、黑边',
    ].filter(Boolean);
    return custom ? `${custom}；${composed.join('，')}` : composed.join('，');
  }

  // ==================== 参考图描述提取 ====================

  /** 参考图描述提取任务（角色外貌 / 场景 / 道具） */
  private static readonly DESCRIBE_TASKS: Record<
    'character' | 'characterPortrait' | 'scene' | 'prop',
    string
  > = {
    character:
      '请观察这张人物参考图，提取外貌特征：性别与年龄段、发型发色、五官特点、体型体态、整体气质；忽略服饰与背景。输出一段 80 字以内的中文外貌描述，可直接用于 AI 生成人物形象，不要任何前缀和解释。',
    characterPortrait:
      '请观察这张人物立绘，提取跨镜头必须保持一致的全部视觉特征：性别与年龄段、发型发色、五官与脸型、体型体态、服装的颜色与款式、标志性配饰（帽子/眼镜/饰品等）。输出一段 100 字以内的中文描述，服装颜色必须写明（如「黄色T恤」「蓝色马甲」），可直接用于 AI 生成同一人物的画面，不要任何前缀和解释。',
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
    kind: 'character' | 'characterPortrait' | 'scene' | 'prop',
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
   * 首帧一致性自动审核（VLM 质检）。
   *
   * 依据：Agnes 的 agnes-2.5-flash 本身支持图片理解（describeImage / detectRotation
   * 已在用同一能力），因此无需新增供应商即可对生成的首帧做自动质检。
   * 产业共识「审核先于重做」：能修的别重做，身份已崩的别硬救。
   *
   * 只在模型可用时执行；任何异常都返回 pass（不阻断主流程）。
   */
  async auditFirstFrame(
    refUris: string[],
    frameUri: string,
    expectCharacters: Array<{ name: string; anchor?: string | null }>,
  ): Promise<FirstFrameAudit> {
    const empty: FirstFrameAudit = { pass: true, issues: [], reasons: [] };
    if (!frameUri || refUris.length === 0) return empty;
    if (!this.factory.isLive('text')) return empty;

    const names = expectCharacters.map((c) => c.name).filter(Boolean);
    const prompt =
      '你是分镜质检员。最后一张图是待检首帧，前面的图是它的参考图（角色立绘）。' +
      '请逐项判断，每项只回答 yes 或 no：' +
      'A) 首帧中每个人的脸型与发型是否与对应角色立绘一致？（一致=yes，不一致=no）' +
      'B) 服装的颜色与款式是否与角色立绘一致？（一致=yes，不一致=no）' +
      'C) 是否存在两个角色的五官或服装特征被混到同一个人身上？（存在=yes，不存在=no）' +
      'D) 画面中是否出现了文字、字幕或水印？（出现=yes，没有=no）' +
      (names.length ? `本镜预期出场角色：${names.join('、')}。` : '') +
      '严格按以下格式输出 4 行，每行一个字母加等号，不要任何解释：\n' +
      'A=yes\nB=yes\nC=no\nD=no';

    try {
      const provider = this.factory.resolve('text');
      const res = await provider.generate('text', {
        prompt,
        options: {
          images: [...refUris, frameUri].slice(0, 8),
          temperature: 0,
          maxTokens: 40,
        },
      });
      const text = (res.text || '').toUpperCase();
      const issues: string[] = [];
      const reasons: string[] = [];
      // polarity：'bad=yes' 表示该项答 yes 才是问题（C/D 是反向问句，不能与 A/B 同判）
      const rules: Array<[string, 'bad=yes' | 'bad=no', string]> = [
        ['A', 'bad=no', '人物脸型/发型与立绘参考图不一致'],
        ['B', 'bad=no', '服装颜色或款式与立绘参考图不一致'],
        ['C', 'bad=yes', '疑似多个角色的五官/服装特征混到同一个人身上（串脸）'],
        ['D', 'bad=yes', '画面中出现文字/字幕/水印'],
      ];
      for (const [key, polarity, msg] of rules) {
        const m = text.match(new RegExp(`\\b${key}\\s*=\\s*(YES|NO)`));
        // 解析不出该项时跳过（模型没按格式回答，不应据此判失败）
        if (!m) continue;
        const failed = polarity === 'bad=yes' ? m[1] === 'YES' : m[1] === 'NO';
        if (failed) {
          issues.push(msg);
          reasons.push(`${key}=${m[1].toLowerCase()}`);
        }
      }

      return { pass: issues.length === 0, issues, reasons };
    } catch (e: any) {
      // 质检失败不阻断生成：宁可放过，不可卡死流水线
      this.logger.warn(`首帧自动审核失败（已跳过）：${e.message}`);
      return empty;
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
