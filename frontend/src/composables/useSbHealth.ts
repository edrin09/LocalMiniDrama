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
 */
export type SbIssue = { level: 'error' | 'warn'; text: string };

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

  // ① 时长必须够念完台词/旁白，否则配音被截断
  const need = speechSeconds(`${sb.dialogue || ''}${sb.narration || ''}`);
  const dur = sb.duration ?? 0;
  if (need > dur) {
    out.push({
      level: 'error',
      text: `台词约需 ${need}s，当前镜头仅 ${dur}s，配音会被截断`,
    });
  }

  const chars = charsOf(sb);
  // ② 同框人数
  if (chars.length > 1) {
    out.push({
      level: 'warn',
      text: `${chars.length} 个角色同框，人物易串脸，建议拆成「说话者特写 + 对方反应镜」`,
    });
  }
  // ③ 四人以上同框：产业共识三人已是极限
  if (chars.length > 3) {
    out.push({
      level: 'error',
      text: `${chars.length} 人同框（≥4），模型极易串脸丢人物，建议拆成多个镜头`,
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

  // ⑥ 角色立绘缺失 → 无参考图，人物一致性无从锁定
  for (const c of chars) {
    if (!c.imageUrl) {
      out.push({ level: 'error', text: `角色「${c.name}」还没有立绘，人物一致性无参考` });
    }
  }

  // ⑦ 场景一致性
  if (!sb.sceneId) {
    out.push({ level: 'warn', text: '未挂场景，画面将完全由提示词自由发挥' });
  } else if (!sceneOf(sb)?.imageUrl) {
    out.push({ level: 'warn', text: '所挂场景还没有场景图，场景一致性无参考' });
  }

  // ⑧ 参考图产物
  if (!sb.imageUrl) out.push({ level: 'warn', text: '尚未生成首帧' });
  else if ((sb.motionDescription || '').trim() && !sb.lastFrameUrl) {
    out.push({ level: 'warn', text: '有动作描述但缺尾帧，镜头衔接会断' });
  }
  return out;
}