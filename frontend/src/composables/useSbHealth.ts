import type { Character, Prop, Scene, Storyboard } from '../types';

/**
 * 分镜体检：把「注定会出问题」的镜头在生成前显式标出来，而不是等出片后才发现。
 *
 * 从 EpisodeEdit.vue 抽离成 composable 的原因：该视图一度超过 3000 行，
 * 体检规则（本项目唯一的「生成前自检」资产）与视图强耦合在一起，
 * 既拖慢渲染也难以单测。这里改为纯函数 + 依赖注入（资产查找由调用方提供）。
 *
 * 每条规则都对应一个后端已修好、但数据本身仍需人工确认的问题：
 * ① 台词念不完（时长 < 台词朗读所需）
 * ② 人物一致性会飘（角色没出立绘 → 没有参考图可注入）
 * ③ 多角色同框 / 四人以上同框（易串脸，产业共识建议 ≤3 人）
 * ④ 一镜多说话人（应一镜一说话人，其余角色做听者反应）
 * ⑤ 参考图预算超限（后端上限 5 张，超限部分角色/道具只靠文字锁定）
 * ⑥ 场景缺失 / 场景缺图（场景一致性的唯一来源）
 * ⑦ 有动作描述但没生成参考图
 *
 * 【关键设计】level 分为两类，绝不混算：
 * - todo：素材「还没生成」，代码一键就能补齐，不是问题，不该吓唬用户；
 * - error/warn：需要人工决策（改台词、改时长、拆镜），才是真问题。
 * 此前把所有规则都算成 error/warn，导致生成前满屏「还没有立绘/还没有场景图」，
 * 用户既无法处理也不知道该干什么 —— 这些其实是待办，不是问题。
 * 每条 todo 都带 fix，UI 直接渲染成可点击的一键修复按钮。
 */
export type SbIssueLevel = 'error' | 'warn' | 'todo';

/** 可一键执行的修复动作（UI 据此渲染按钮；后端已有对应接口） */
export type SbFixKind = 'generateAssets' | 'fitDuration';

export type SbIssue = {
  level: SbIssueLevel;
  text: string;
  /** 存在即表示这条可由代码自动修复 */
  fix?: { kind: SbFixKind; label: string };
};

/** 中文口播语速（字/秒），与后端 normDuration 保持一致 */
export const SPEECH_CPS = 4.5;

/** 后端注入首帧的参考图上限（Agnes Flash 硬限制，超出会 HTTP 400） */
export const REF_IMG_CAP = 5;

/** 台词/旁白朗读所需秒数（标点不计入字数） */
export function speechSeconds(text?: string | null): number {
  const s = (text || '').replace(/[\s\p{P}]/gu, '');
  return s ? Math.ceil(s.length / SPEECH_CPS) + 1 : 0;
}

/** 本镜实际需要的参考图数量：角色立绘 + 场景 + 道具 + 上一镜尾帧 */
export function expectedRefCount(charCount: number, hasScene: boolean, hasProp: boolean): number {
  return charCount + (hasScene ? 1 : 0) + (hasProp ? 1 : 0) + 1;
}

/** 体检所需的资产查找器（由调用方注入，composable 本身不持有全局状态） */
export interface SbIssueAssets {
  charsOf(sb: Storyboard): Character[];
  propsOf(sb: Storyboard): Prop[];
  sceneOf(sb: Storyboard): Scene | null;
}

/** 对单个分镜做体检，返回问题列表（空数组 = 无问题） */
export function sbIssues(sb: Storyboard, assets: SbIssueAssets): SbIssue[] {
  const { charsOf, propsOf, sceneOf } = assets;
  const out: SbIssue[] = [];

  // ① 时长：后端在每次保存分镜时已按台词实际长度自动校准（normDuration），
  //    因此这里不再报「配音会被截断」—— 用户既无法处理，代码也已兜住。
  //    仅保留信息：当前时长明显长于台词，供想收紧节奏的人参考。
  const need = speechSeconds(`${sb.dialogue || ''}${sb.narration || ''}`);
  const dur = sb.duration ?? 0;
  if (need && dur > need + 3) {
    out.push({
      level: 'warn',
      text: `台词仅需 ${need}s，本镜 ${dur}s 偏长，可手动收紧（不影响配音完整性）`,
    });
  }

  const chars = charsOf(sb);
  // ② 同框人数。后端提示词已锁定确切人数、并强制各角色服装主色互斥，
  // 所以 2 人同框是产业常规做法，仅作提示（info 级不再是 error/warn）；
  // 只有 ≥4 人（模型极易串脸丢人物）才升级为真问题。
  if (chars.length > 1) {
    out.push({
      level: chars.length > 3 ? 'error' : 'warn',
      text:
        chars.length > 3
          ? `${chars.length} 人同框（≥4），模型极易串脸丢人物，建议拆成多个镜头`
          : `${chars.length} 个角色同框：提示词已锁定人数与各自服装主色防串脸；若成片仍串脸再手动拆镜`,
    });
  }

  // ④ 一镜一说话人。
  // 台词字段是整镜一段对白，因此按「对白中出现多个角色名」判定多人同时说话。
  const dialogText = (sb.dialogue || '').trim();
  if (dialogText && chars.length > 1) {
    const hit = chars.filter((c) => dialogText.includes(c.name));
    if (hit.length > 1) {
      out.push({
        level: 'error',
        text: `本镜对白中出现 ${hit.length} 个角色（${hit.map((c) => c.name).join('、')}），疑似多人同时说话，建议一镜只保留一个主要说话人`,
      });
    }
  }

  // ⑤ 参考图预算（后端上限 5 张，超限部分角色/道具将只靠文字锚点锁定）
  const propCount = propsOf(sb).length;
  const needRefs = expectedRefCount(chars.length, !!sb.sceneId, propCount > 0);
  if (needRefs > REF_IMG_CAP) {
    out.push({
      level: 'warn',
      text: `本镜参考图约需 ${needRefs} 张，超出上限 ${REF_IMG_CAP} 张，部分角色/道具将只靠文字锁定`,
    });
  }

  // ⑥ 角色立绘缺失 → 无参考图，人物一致性无从锁定。
  //    这是「素材还没生成」，代码点一下就能补，降为 todo 并给一键补齐按钮。
  for (const c of chars) {
    if (!c.imageUrl) {
      out.push({
        level: 'todo',
        text: `角色「${c.name}」还没有立绘（生成后即可作为人物一致性参考）`,
        fix: { kind: 'generateAssets', label: '一键补齐素材' },
      });
    }
  }

  // ⑦ 场景一致性
  if (!sb.sceneId) {
    out.push({ level: 'warn', text: '未挂场景，画面将完全由提示词自由发挥' });
  } else if (!sceneOf(sb)?.imageUrl) {
    out.push({
      level: 'todo',
      text: `场景「${sceneOf(sb)?.location || sb.sceneId}」还没有场景图（生成后即可锁定空间与色调）`,
      fix: { kind: 'generateAssets', label: '一键补齐素材' },
    });
  }

  // ⑧ 参考图产物：同样是待办，不是问题
  if (!sb.imageUrl) {
    out.push({
      level: 'todo',
      text: '尚未生成首帧',
      fix: { kind: 'generateAssets', label: '一键补齐素材' },
    });
  } else if ((sb.motionDescription || '').trim() && !sb.lastFrameUrl) {
    out.push({
      level: 'todo',
      text: '有动作描述但缺尾帧，镜头衔接会断',
      fix: { kind: 'generateAssets', label: '一键补齐素材' },
    });
  }
  return out;
}

/** 是否为「素材待生成」类（todo）：这类可由代码一键补齐，不算问题 */
export function isTodo(it: SbIssue): boolean {
  return it.level === 'todo';
}

/** 需要人工决策的真问题（error/warn 且无 fix） */
export function realIssues(list: SbIssue[]): SbIssue[] {
  return list.filter((it) => !isTodo(it) && !it.fix);
}

/** 可一键修复的条目（含 todo 与带 fix 的项） */
export function fixableIssues(list: SbIssue[]): SbIssue[] {
  return list.filter((it) => !!it.fix);
}