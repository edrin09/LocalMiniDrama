/**
 * 剧本拆解的纯逻辑层（无副作用、无 IO，可单测）。
 *
 * 从 generate.service.ts 抽离的原因：该文件一度超过 2600 行，
 * 拆解相关的规范化/匹配/合并逻辑与「生成流水线」主流程混在一起，
 * 既难读也难测。这里把纯函数集中到独立模块，主 service 只保留编排。
 */

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
    characters: string[];
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

/** 合法的情绪枚举 */
export const EMOTIONS = [
  'neutral',
  'happy',
  'sad',
  'angry',
  'fear',
  'surprise',
] as const;

/**
 * 单次请求剧本的最大字符数。
 * 一次性把整篇剧本塞给模型，长剧本必然触发 maxTokens 截断 → JSON 残缺 →
 * 解析失败，或只拆出前半段剧情（分镜质量差的重要成因）。
 */
export const CHUNK_CHARS = 3000;

/**
 * 剧本按段落边界切块（每块上限 CHUNK_CHARS）。
 * 切点优先落在空行处，避免把一句台词或一个动作描述腰斩。
 */
export function splitScriptChunks(script: string): string[] {
  if (!script || !script.trim()) return [];
  if (script.length <= CHUNK_CHARS) return [script];
  const chunks: string[] = [];
  let cur = '';
  for (const p of script.split(/\n{2,}/)) {
    const piece = cur ? `${cur}\n\n${p}` : p;
    if (piece.length > CHUNK_CHARS && cur) {
      chunks.push(cur);
      cur = p;
    } else {
      cur = piece;
    }
    // 单个段落本身超长（整段没有空行）：按换行再切一刀
    while (cur.length > CHUNK_CHARS) {
      let cut = cur.lastIndexOf('\n', CHUNK_CHARS);
      if (cut < CHUNK_CHARS * 0.5) cut = CHUNK_CHARS;
      chunks.push(cur.slice(0, cut));
      cur = cur.slice(cut);
    }
  }
  if (cur.trim()) chunks.push(cur);
  return chunks.filter((c) => c.trim());
}

/**
 * 从剧本原文里摘取与某个素材（场景地点 / 道具名）相关的片段。
 *
 * 背景：场景图与道具图此前只靠自身 description 生成，等于「自由发挥」——
 * 剧本里写明的年代、地点、道具归属与用途全部丢失，出图与剧情脱节。
 * 这里把剧本中命中关键词的句子连同前后各 1 句邻居取出，作为生图的事实依据。
 *
 * 纯函数（无 IO），命中为空时返回空串，调用方据此提示「缺少剧本依据」。
 */
export function extractScriptExcerpt(
  script: string | null | undefined,
  keywords: Array<string | null | undefined>,
  opts: { maxChars?: number; neighbors?: number } = {},
): string {
  const maxChars = opts.maxChars ?? 400;
  const neighbors = opts.neighbors ?? 1;
  const text = (script || '').trim();
  if (!text || !keywords.length) return '';

  const keys = keywords
    .map((k) => (k || '').replace(/[\s·・．,，。、]/g, ''))
    .filter((k) => k.length >= 2);
  if (!keys.length) return '';

  // 按换行断句（剧本一行一句），保留原顺序与行号，便于回看
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return '';

  const norm = (s: string) => s.replace(/[\s·・．,，。、]/g, '');
  const hit = lines.map((l) => {
    const n = norm(l);
    return keys.some((k) => n.includes(k));
  });
  if (!hit.some(Boolean)) return '';

  const picked = new Set<number>();
  hit.forEach((h, i) => {
    if (!h) return;
    for (let d = -neighbors; d <= neighbors; d++) {
      const j = i + d;
      if (j >= 0 && j < lines.length) picked.add(j);
    }
  });

  const kept = [...picked].sort((a, b) => a - b).map((i) => lines[i]);
  const out: string[] = [];
  let used = 0;
  for (const line of kept) {
    const add = out.length ? ` ${line}` : line;
    if (used + add.length > maxChars) break;
    out.push(add);
    used += add.length;
  }
  return out.join('').trim();
}

/** 合并多段拆解结果：角色/场景/道具按名称去重，分镜按顺序拼接 */
export function mergeParsed(parts: ParsedScript[]): ParsedScript {
  const out: ParsedScript = { characters: [], scenes: [], props: [], storyboards: [] };
  const key = (s?: string | null) => (s || '').replace(/[\s·・．,，。、]/g, '');
  const seenChar = new Set<string>();
  const seenScene = new Set<string>();
  const seenProp = new Set<string>();
  for (const p of parts) {
    for (const c of p.characters) {
      const k = key(c.name);
      if (!k || seenChar.has(k)) continue;
      seenChar.add(k);
      out.characters.push(c);
    }
    for (const s of p.scenes) {
      if (!key(s.location)) continue;
      const k = `${key(s.location)}::${key(s.time)}`;
      // 同地点已有条目：只补全缺失的描述，不重复建场景
      // （description 在后一段才写全是常态，先判 seen 会直接跳过，补全就永远不生效）
      const dup = out.scenes.findIndex((x) => key(x.location) === key(s.location));
      if (dup >= 0) {
        if (!out.scenes[dup].description && s.description) {
          out.scenes[dup].description = s.description;
        }
        continue;
      }
      if (seenScene.has(k)) continue;
      seenScene.add(k);
      out.scenes.push(s);
    }
    for (const pr of p.props) {
      const k = key(pr.name);
      if (!k || seenProp.has(k)) continue;
      seenProp.add(k);
      out.props.push(pr);
    }
    out.storyboards.push(...p.storyboards);
  }
  return out;
}

/** 从 AI 返回文本中稳健提取 JSON 对象（容忍代码块包裹与前后杂讯） */
export function extractJsonObject(raw: string): any {
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

/** 字符串归一化：trim 后空串转 null */
export function normStr(v: any): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s || null;
}

/** 情绪归一化：不在枚举内一律回退 neutral */
export function normEmotion(v: any): string {
  const s = String(v ?? '').trim();
  return (EMOTIONS as readonly string[]).includes(s) ? s : 'neutral';
}

/**
 * 时长归一化：以台词实际可朗读时长为准，而不是盲信模型给的数字。
 * 中文语速约 4.5 字/秒（留 1 秒起落幅余量），台词越长镜头必须越长，
 * 否则配音念到一半就被视频截断 —— 这是成片「说不完」的根因。
 * 模型给的 duration 仅在与台词需求差距不大时采纳，避免情绪镜被强行拉长。
 */
export function normDuration(
  v: any,
  dialogue?: string | null,
  narration?: string | null,
): number {
  const spoken = `${dialogue || ''}${narration || ''}`.replace(/[\s\p{P}]/gu, '');
  // 台词越长越以台词为准；无台词时才退回模型给值
  const needed = spoken ? Math.ceil(spoken.length / 4.5) + 1 : 0;
  const modelVal = Number(v);
  const base = needed > 0 ? needed : Number.isFinite(modelVal) ? Math.round(modelVal) : 5;
  // 有台词但模型给了明显更长的值时，取两者较大值（情绪镜需要留白）
  const raw =
    needed > 0 && Number.isFinite(modelVal)
      ? Math.max(needed, Math.round(modelVal))
      : base;
  return Math.min(12, Math.max(4, raw));
}

/** 名称归一化：去空格与常见标点、全角转半角，便于模糊比对 */
export function normalizeNameKey(s?: string | null): string {
  return (s || '')
    .replace(/[\s·・．.,，。、:：;；!！?？"'"“”‘’()（）\[\]【】]/g, '')
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) =>
      String.fromCharCode(c.charCodeAt(0) - 0xfee0),
    )
    .toLowerCase();
}

/** 场景去重键：地点 + 时间段（归一化后），同地点不同时间视为不同场景 */
export function locTimeKey(location?: string | null, time?: string | null): string {
  return `${normalizeNameKey(location)}::${normalizeNameKey(time)}`;
}

/**
 * 名称 → id 的匹配：先精确，再做归一化精确，最后做包含关系匹配。
 * 包含关系仅在「唯一命中」时采纳（避免「蛋蛋」误挂到「小蛋蛋的哥哥」上）。
 */
export function matchName(
  map: Map<string, number>,
  name?: string | null,
): number | null {
  if (!name) return null;
  const exact = map.get(name);
  if (exact != null) return exact;

  const key = normalizeNameKey(name);
  if (!key) return null;
  const entries = [...map.entries()];
  const normHit = entries.find(([k]) => normalizeNameKey(k) === key);
  if (normHit) return normHit[1];

  const partial = entries.filter(([k]) => {
    const kk = normalizeNameKey(k);
    // 库内名至少 2 字才参与包含匹配（「爸」不该命中「老爸」这种单字歧义太多的情况）
    if (kk.length < 2) return false;
    return kk.includes(key) || key.includes(kk);
  });
  if (partial.length === 1) return partial[0][1];
  return null;
}

/** 规范化拆解结构：剔除空名条目、丢弃全空分镜、夹取取值范围 */
export function normalizeParsedScript(raw: any): ParsedScript {
  const src = raw && typeof raw === 'object' ? raw : {};
  const arr = (v: any) => (Array.isArray(v) ? v : []);
  const characters = arr(src.characters)
    .map((c: any) => ({
      name: normStr(c?.name) ?? '',
      role: normStr(c?.role),
      roleLabel: normStr(c?.roleLabel),
      appearance: normStr(c?.appearance),
      intro: normStr(c?.intro),
    }))
    .filter((c: any) => c.name);
  // 已知角色名集合：用于剥离对白里的「角色名：」前缀（模型偶发带出）
  const charNameSet = new Set(characters.map((c: any) => c.name as string));
  const stripSpeakerPrefix = (text: string | null): string | null => {
    if (!text) return text;
    const m = text.match(/^([^：:]{1,12})[：:]\s*(.+)$/s);
    if (m && charNameSet.has(m[1].trim())) return m[2].trim();
    return text;
  };
  const scenes = arr(src.scenes)
    .map((s: any) => ({
      location: normStr(s?.location) ?? '',
      time: normStr(s?.time),
      description: normStr(s?.description),
    }))
    .filter((s: any) => s.location);
  const props = arr(src.props)
    .map((p: any) => ({
      name: normStr(p?.name) ?? '',
      type: normStr(p?.type),
      description: normStr(p?.description),
    }))
    .filter((p: any) => p.name);
  const storyboards = arr(src.storyboards)
    .map((sb: any) => {
      // 多角色：characters 数组（新格式），回退单值 character（旧格式/手工数据）
      let names: string[] = arr(sb?.characters)
        .map((n: any) => normStr(n))
        .filter((n: string | null): n is string => Boolean(n));
      const single = normStr(sb?.character);
      if (names.length === 0 && single) names = [single];
      names = [...new Set(names)];
      return {
        characters: names,
        character: names[0] ?? null,
        scene: normStr(sb?.scene),
        prop: normStr(sb?.prop),
        dialogue: stripSpeakerPrefix(normStr(sb?.dialogue)),
        narration: normStr(sb?.narration),
        sceneDescription: normStr(sb?.sceneDescription),
        motionDescription: normStr(sb?.motionDescription),
        emotion: normEmotion(sb?.emotion),
        duration: normDuration(sb?.duration),
      };
    })
    .filter(
      (sb: any) =>
        sb.dialogue || sb.narration || sb.sceneDescription || sb.motionDescription,
    );
  return { characters, scenes, props, storyboards };
}