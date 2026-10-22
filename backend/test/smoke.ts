/**
 * 单元测试（纯逻辑，不触网、不触库）：校验提示词净化与拆解/时长/匹配等纯逻辑。
 *
 * 【正式测试入口】已挂到 package.json：
 *   npm test              # = smoke + integration
 *   npm run test:smoke    # 仅本文件
 * 退出码 0 = 全部通过，1 = 有失败项（可直接用于 CI）。
 */
import { stripAnchorMeta, dedupeStyleAnchor, PromptService } from '../src/ai/prompt.service';
import { StorageService } from '../src/ai/storage.service';
import { GenerateService, allocateFirstFrameRefs } from '../src/generate/generate.service';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AppConfigService } from '../src/app-config/app-config.service';
import { extractScriptExcerpt } from '../src/generate/script-parse.util';
import {
  parseOutputSpec,
  imageRatioOf,
  propRatioOf,
  videoSizeOf,
  resolutionOf,
} from '../src/output-spec';

const STYLE = { artStyle: 'cartoon' } as any;
let fail = 0;
const eq = (name: string, got: any, want: any) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fail++; console.log(`FAIL ${name}\n  got : ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`); }
  else console.log(`ok   ${name}`);
};

// 1) 内部标记必须被剥离，不能进入生图提示词
eq('strip meta', stripAnchorMeta('【风格:cartoon|a2】蓝马甲；黑短发'), '蓝马甲；黑短发');
eq('strip none', stripAnchorMeta(null), '');

// 2) 锚点里重复的风格词必须被剔除，且不能把人物特征一起删掉
const dirty = '2D卡通动漫风格，日系赛璐璐动画质感，明亮大眼；面部轮廓：尖下巴；发型发色：黑色短发；服装：蓝色马甲';
const cleaned = dedupeStyleAnchor(dirty, STYLE);
eq('dedupe drops style', cleaned.includes('卡通动漫'), false);
eq('dedupe keeps identity', cleaned.includes('蓝色马甲') && cleaned.includes('黑色短发'), true);

// 3) 全部内容都是风格词时必须回退原文，不能返回空串导致人物特征丢失
eq('dedupe fallback', dedupeStyleAnchor('2D卡通动漫风格，日系赛璐璐动画质感，清晰干净的线条描边', STYLE).length > 0, true);

// 4) 多角色提示词必须锁定人数并禁止特征互串
const svc = new PromptService(null as any);
const prompt = svc.storyboardImagePrompt(
  {
    sb: { number: 1, sceneDescription: '两人对峙', motionDescription: '' },
    characters: [
      { name: '老爸', appearance: '方脸，黑色短发，穿蓝色马甲' },
      { name: '蛋蛋', appearance: '圆脸，棕色卷发，穿黄色T恤' },
    ],
    scene: { location: '客厅', time: '白天' },
  },
  STYLE,
);
eq('headcount locked', prompt.includes('恰好有 2 个人物'), true);
eq('no face mixing', prompt.includes('禁止把不同角色的五官或服装特征混到同一个人身上'), true);
eq('char1 identity', prompt.includes('蓝色马甲'), true);
eq('char2 identity', prompt.includes('黄色T恤'), true);
eq('no meta tag in prompt', /【风格:/.test(prompt), false);
eq('single char headcount', svc.storyboardImagePrompt(
  { sb: { number: 1 }, characters: [{ name: '蛋蛋', appearance: '圆脸' }] }, STYLE
).includes('恰好有 1 个人物'), true);

// 4b) 服装主色互斥（MSR 论文指认的 reference confusion 失败模式）
eq('wardrobe colors mutually exclusive', prompt.includes('各角色的服装主色必须彼此明显不同'), true);
eq('wardrobe rule only when multi-char', svc.storyboardImagePrompt(
  { sb: { number: 1 }, characters: [{ name: '蛋蛋', appearance: '圆脸' }] }, STYLE
).includes('服装主色必须彼此明显不同'), false);

// 4c) 参考图四段式：必须按「角色立绘 / 场景 / 道具 / 尾帧」声明图间关系，
//     且序号与实际注入顺序一致（官方：第一个图 = 主体）
const multiRef = svc.storyboardImagePrompt(
  {
    sb: { number: 1, sceneDescription: '客厅对峙' },
    characters: [
      { name: '老爸', appearance: '方脸，黑色短发，穿蓝色马甲' },
      { name: '蛋蛋', appearance: '圆脸，棕色卷发，穿黄色T恤' },
    ],
    scene: { location: '客厅', time: '白天' },
    prop: { name: '手机', description: '黑色手机' },
    refs: [
      { kind: 'character', name: '老爸' },
      { kind: 'character', name: '蛋蛋' },
      { kind: 'scene', name: '客厅' },
      { kind: 'prop', name: '手机' },
      { kind: 'tail', name: '上一镜尾帧' },
    ],
    hasTailRef: true,
  },
  STYLE,
);
eq('ref relation note present', multiRef.includes('参考图按所附顺序编号'), true);
eq('ref declares char1 as pic1', multiRef.includes('第1张为角色「老爸」的形象立绘'), true);
eq('ref declares char2 as pic2', multiRef.includes('第2张为角色「蛋蛋」的形象立绘'), true);
eq('ref declares scene', multiRef.includes('第3张为场景「客厅」的参考图'), true);
eq('ref declares prop', multiRef.includes('第4张为道具「手机」的参考图'), true);
eq('ref declares tail as non-portrait', multiRef.includes('第5张为上一镜的画面衔接参考（非人物立绘）'), true);
eq('char ref index in body matches order', multiRef.includes('角色「老爸」') && multiRef.includes('其形象立绘为参考图第 1 张'), true);
eq('no legacy tail note', multiRef.includes('最后一张为上一镜画面衔接参考'), false);
eq('no refs -> no relation note', svc.storyboardImagePrompt(
  { sb: { number: 1 }, characters: [{ name: '蛋蛋', appearance: '圆脸' }] }, STYLE
).includes('参考图按所附顺序编号'), false);

// 5) 视频提示词同样禁止多人融合
eq('video no mixing', svc.videoPrompt(
  { sb: { number: 1 }, characters: [{ name: 'A', appearance: '短发' }, { name: 'B', appearance: '长发' }] }, STYLE,
).includes('禁止多人互相融合或特征互串'), true);

// ===== 拆解流水线纯逻辑（拆块 / 合并 / 时长 / 名称匹配）=====
// 这些函数已从 GenerateService 抽离到 script-parse.util.ts（纯函数，直接导入）
import {
  splitScriptChunks,
  mergeParsed,
  normDuration,
  matchName,
  locTimeKey,
  normalizeParsedScript,
  extractJsonObject,
  normEmotion,
  CHUNK_CHARS,
} from '../src/generate/script-parse.util';

const svc2: any = Object.create(GenerateService.prototype);

const longScript = Array.from({ length: 60 }, (_, i) => `第${i}段剧情描述。`.repeat(30)).join('\n\n');
const chunks: string[] = splitScriptChunks(longScript);
eq('chunk splits long script', chunks.length > 1, true);
// 切块按空行边界切分，因此还原时用 '\n\n' 拼接（内容不丢，只有分隔符被重新规范化）
eq('chunk covers all text', chunks.join('\n\n') === longScript, true);
eq('chunk respects cap', chunks.every((c) => c.length <= CHUNK_CHARS + 200), true);
eq('short script one chunk', splitScriptChunks('很短').length, 1);
eq('empty script', splitScriptChunks('   ').length, 0);

// 多段合并：角色/道具跨段去重，场景同地点补全描述，分镜顺序拼接
const merged = mergeParsed([
  { characters: [{ name: '老爸', role: 'main', roleLabel: '父亲', appearance: '方脸', intro: null }],
    scenes: [{ location: '客厅', time: '白天', description: null }], props: [], storyboards: [] },
  { characters: [{ name: '老爸', role: 'main', roleLabel: '父亲', appearance: '方脸', intro: null },
                 { name: '蛋蛋', role: 'main', roleLabel: '主角', appearance: '圆脸', intro: null }],
    scenes: [{ location: '客厅', time: '白天', description: '沙发与茶几' }],
    props: [{ name: '手机', type: null, description: null }],
    storyboards: [
      { characters: ['蛋蛋'], character: '蛋蛋', scene: '客厅', prop: '', dialogue: '爸', narration: null, sceneDescription: 'a', motionDescription: null, emotion: 'neutral', duration: 5 },
      { characters: ['老爸'], character: '老爸', scene: '客厅', prop: '手机', dialogue: '嗯', narration: null, sceneDescription: 'b', motionDescription: null, emotion: 'neutral', duration: 5 },
    ] },
]);
eq('merge dedup characters', merged.characters.length, 2);
eq('merge dedup scene + fill desc', merged.scenes.length === 1 && merged.scenes[0].description === '沙发与茶几', true);
eq('merge props', merged.props.length, 1);
eq('merge keeps storyboard order', merged.storyboards.map((s: any) => s.character).join(','), '蛋蛋,老爸');

// 时长：台词不够念时必须拉长（截断配音）；台词很短时保留模型给的情绪留白
eq('duration keeps model when enough', normDuration(5, '你来了', null), 5);
eq('duration from long line', normDuration(4, '这是一句相当长的台词大概有三十个字左右需要更长的镜头才能念完', null) > 4, true);
eq('duration clamped max', normDuration(99, null, null), 12);
eq('duration clamped min', normDuration(1, null, null), 4);
eq('duration default when no value', normDuration(undefined, null, null), 5);
// 标点不计入字数，故「你好！！！」与「你好」需求相同
eq('punctuation not counted', normDuration(5, '你好！！！（）', null), normDuration(5, '你好', null));
// 旁白同样计入时长需求（27 字 → 约 7s）
eq('narration also counted', normDuration(4, '', '这是一段相当长的旁白内容大约需要超过四秒才能念完完毕'), 7);

// 名称匹配：容错空格/标点/别名，歧义时不瞎猜
const map = new Map<string, number>([['蛋蛋', 1], ['老爸', 2], ['妈妈', 3]]);
eq('name exact', matchName(map, '蛋蛋'), 1);
eq('name trims space', matchName(map, ' 蛋蛋 '), 1);
eq('name strips punct', matchName(map, '老爸！'), 2);
eq('name unique partial', matchName(map, '爸'), 2);
eq('name unknown -> null', matchName(map, '路人甲'), null);
eq('name null -> null', matchName(map, ''), null);
// 场景去重键：同地点不同时间段必须是不同场景
eq('locTime same', locTimeKey('客厅', '白天'), locTimeKey(' 客厅 ', '白天'));
eq('locTime differs', locTimeKey('客厅', '白天') !== locTimeKey('客厅', '夜晚'), true);

// 尾帧需求判定：静态对话镜/空镜不该花冤枉钱
eq('tail needed when motion', svc2.needsTailFrame({ motionDescription: '角色转身', characters: [{ id: 1 }] }), true);
eq('tail skipped static', svc2.needsTailFrame({ motionDescription: '', characters: [{ id: 1 }] }), false);
eq('tail skipped empty shot', svc2.needsTailFrame({ motionDescription: '镜头推进', characters: [] }), false);

// ===== 路径护栏（absFromUrl 收敛后的单一入口）=====
const storage = new StorageService();
eq('absFromUrl normal', storage.absFromUrl('/uploads/1/2/a.png') !== null, true);
eq('absFromUrl null', storage.absFromUrl(null), null);
eq('absFromUrl remote rejected', storage.absFromUrl('https://x.com/a.png'), null);
eq('absFromUrl non-uploads rejected', storage.absFromUrl('/etc/passwd'), null);
// 目录穿越必须被护栏拦掉（这是两份实现漂移时最容易丢掉的那道防线）
eq('absFromUrl traversal blocked', storage.absFromUrl('/uploads/../../secret.txt'), null);
eq('absFromUrl deep traversal blocked', storage.absFromUrl('/uploads/1/../../../secret.txt'), null);

// ===== 首帧 VLM 自动审核（auditFirstFrame）=====
const mkAuditSvc = (reply: string | null, live = true) =>
  new PromptService({
    isLive: () => live,
    resolve: () => ({
      generate: async () => {
        if (reply === null) throw new Error('provider down');
        return { status: 'success', text: reply };
      },
    }),
  } as any);

async function auditTests() {
  // 全部合格 → 放行
  const okAudit = await mkAuditSvc('A=yes\nB=yes\nC=no\nD=no').auditFirstFrame(
    ['data:image/png;base64,AAA'],
    'data:image/png;base64,BBB',
    [{ name: '老爸' }],
  );
  eq('audit pass when all good', okAudit.pass, true);
  eq('audit no issues', okAudit.issues.length, 0);

  // 服装不一致 → 拦截
  const badCloth = await mkAuditSvc('A=yes\nB=no\nC=no\nD=no').auditFirstFrame(
    ['data:image/png;base64,AAA'],
    'data:image/png;base64,BBB',
    [{ name: '老爸' }],
  );
  eq('audit fails on wardrobe mismatch', badCloth.pass, false);
  eq('audit reports wardrobe issue', badCloth.issues.some((i) => i.includes('服装')), true);

  // 串脸 → 拦截
  const faceMix = await mkAuditSvc('A=yes\nB=yes\nC=yes\nD=no').auditFirstFrame(
    ['data:image/png;base64,AAA'],
    'data:image/png;base64,BBB',
    [{ name: '老爸' }, { name: '蛋蛋' }],
  );
  eq('audit fails on face mixing', faceMix.pass, false);
  eq('audit reports face mixing', faceMix.issues.some((i) => i.includes('串脸')), true);

  // 模型异常 → 必须放行，绝不阻断主流程
  const crashed = await mkAuditSvc(null).auditFirstFrame(
    ['data:image/png;base64,AAA'],
    'data:image/png;base64,BBB',
    [{ name: '老爸' }],
  );
  eq('audit degrades open on provider error', crashed.pass, true);

  // 文本模型未配置 → 直接跳过审核
  const offline = await mkAuditSvc('A=no', false).auditFirstFrame(
    ['data:image/png;base64,AAA'],
    'data:image/png;base64,BBB',
    [{ name: '老爸' }],
  );
  eq('audit skipped when model offline', offline.pass, true);

  // 无参考图 / 无待检图 → 跳过
  eq('audit skipped without refs',
    (await mkAuditSvc('A=no').auditFirstFrame([], 'data:image/png;base64,BBB', [])).pass, true);
  eq('audit skipped without frame',
    (await mkAuditSvc('A=no').auditFirstFrame(['data:image/png;base64,AAA'], '', [])).pass, true);

  // 审核必须把参考图 + 待检图一起送给模型
  let sentImages = 0;
  const captureSvc = new PromptService({
    isLive: () => true,
    resolve: () => ({
      generate: async (_cap: any, req: any) => {
        sentImages = req.options.images.length;
        return { status: 'success', text: 'A=yes\nB=yes\nC=no\nD=no' };
      },
    }),
  } as any);
  await captureSvc.auditFirstFrame(
    ['r1', 'r2'],
    'frame',
    [{ name: '老爸' }],
  );
  eq('audit sends refs + frame', sentImages, 3);
}

// ===== 参考图优先级分配（真实实现，allocateFirstFrameRefs）=====
const mkRef = (kind: string, name: string) => ({ kind, name, uri: `uri:${name}` }) as any;

// 预算充足：全部采纳，且顺序固定为 角色 → 场景 → 道具 → 尾帧
{
  const a = allocateFirstFrameRefs(
    [mkRef('tail', '尾帧'), mkRef('prop', '手机'), mkRef('scene', '客厅'),
     mkRef('character', '蛋蛋'), mkRef('character', '老爸')],
    5,
  );
  eq('alloc keeps all within cap', a.refs.length, 5);
  eq('alloc order character->scene->prop->tail',
    a.refs.map((r: any) => r.kind).join(','),
    'character,character,scene,prop,tail');
  eq('alloc keeps character input order',
    a.refs.filter((r: any) => r.kind === 'character').map((r: any) => r.name).join(','),
    '蛋蛋,老爸');
  eq('alloc no drop within cap', a.droppedCharacters.length + a.droppedProps.length, 0);
  eq('alloc scene kept', a.sceneDropped, false);
}

// 超预算：场景必须挤掉道具与尾帧（场景一致性不可丢）
{
  const a = allocateFirstFrameRefs(
    [mkRef('tail', '尾帧'), mkRef('prop', '手机'), mkRef('prop', '钥匙'),
     mkRef('scene', '客厅'), mkRef('character', '老爸'), mkRef('character', '蛋蛋')],
    5,
  );
  eq('alloc respects cap', a.refs.length, 5);
  eq('alloc keeps scene over props', a.sceneDropped, false);
  eq('alloc kinds when over budget',
    a.refs.map((r: any) => r.kind).join(','),
    'character,character,scene,prop,prop');
  eq('alloc drops tail first', a.refs.some((r: any) => r.kind === 'tail'), false);
}

// 角色超多：场景图仍要保留（调研文档把场景列为 P0，与说话人同级），
// 被挤掉的应是次要角色与道具。
{
  const a = allocateFirstFrameRefs(
    [mkRef('character', 'A'), mkRef('character', 'B'), mkRef('character', 'C'),
     mkRef('character', 'D'), mkRef('character', 'E'), mkRef('scene', '客厅')],
    5,
  );
  eq('alloc caps crowded cast', a.refs.length, 5);
  eq('alloc scene survives crowd', a.sceneDropped, false);
  eq('alloc scene present in crowded cast',
    a.refs.some((r: any) => r.kind === 'scene'), true);
  eq('alloc drops surplus chars',
    a.droppedCharacters.length > 0, true);
}

// 兜底：cap=0 时不得返回任何参考图；空输入同样安全
eq('alloc handles zero cap', allocateFirstFrameRefs([mkRef('character', 'A')], 0).refs.length, 0);
eq('alloc empty input', allocateFirstFrameRefs([], 5).refs.length, 0);

// ============ 场景/道具出图必须建立在「剧本 + 已生成角色 + 引用分镜」之上 ============
// 需求：不能随意生成。以下覆盖「剧本摘录 → 提示词注入 → 参考图声明」整条链路。
{
  const script = [
    '第一集 内景 老张家客厅 日',
    '这是一间低矮的土坯房，墙上糊着发黄的报纸。',
    '蛋蛋从里屋拿出一个掉漆的铁皮青蛙。',
    '老爸接过铁皮青蛙，拇指按住发条。',
    '屋外传来几声狗叫，院里停着二八大杠。',
    '院墙根还堆着两捆发黄的麦秸。',
  ].join('\n');

  // 摘录：命中行 + 前后各 1 句邻居，超出范围的无关行不取
  const sceneExcerpt = extractScriptExcerpt(script, ['客厅'], { maxChars: 400 });
  eq('excerpt hits scene location', sceneExcerpt.includes('土坯房'), true);
  eq('excerpt stops at neighbour window', sceneExcerpt.includes('铁皮青蛙'), false);
  eq('excerpt drops far line', sceneExcerpt.includes('麦秸'), false);

  const wideExcerpt = extractScriptExcerpt(script, ['客厅', '铁皮青蛙'], { maxChars: 400 });
  eq('excerpt unions multiple keywords', wideExcerpt.includes('二八大杠'), true);

  const propExcerpt = extractScriptExcerpt(script, ['铁皮青蛙'], { maxChars: 400 });
  eq('excerpt hits prop name', propExcerpt.includes('掉漆'), true);

  eq('excerpt empty when no hit', extractScriptExcerpt(script, ['火星基地']).length, 0);
  eq('excerpt empty when no script', extractScriptExcerpt(null, ['客厅']).length, 0);
  eq('excerpt ignores 1-char keyword', extractScriptExcerpt(script, ['的']).length, 0);
  eq('excerpt capped by maxChars',
    extractScriptExcerpt(script, ['客厅', '客厅', '客厅'], { maxChars: 10 }).length <= 10, true);

  // 场景提示词：必须带上剧本依据、分镜画面、角色锚点、参考图声明
  const scenePrompt = svc.sceneImagePrompt(
    { location: '老张家客厅', time: '日', description: '低矮土坯房' },
    false,
    STYLE,
    '「蛋蛋」=人物、「老爸」=人物',
    {
      scriptExcerpt: sceneExcerpt,
      shotLines: ['分镜#1：客厅正面全景，蛋蛋蹲在门槛上'],
      charAnchors: ['「蛋蛋」圆脸，棕色卷发，穿黄色T恤'],
      refNames: ['用户上传的参考图'],
    },
  );
  eq('scene prompt carries script basis', scenePrompt.includes('剧本依据'), true);
  eq('scene prompt carries script text', scenePrompt.includes('土坯房'), true);
  eq('scene prompt carries shot usage', scenePrompt.includes('分镜#1'), true);
  eq('scene prompt carries char anchor', scenePrompt.includes('黄色T恤'), true);
  eq('scene prompt declares refs 1-based', scenePrompt.includes('图1=用户上传的参考图'), true);
  eq('scene prompt forbids人物', scenePrompt.includes('绝不出现人物'), true);
  eq('scene prompt forbids free invention', scenePrompt.includes('禁止与之矛盾或自由发挥'), true);
  eq('scene prompt still no meta tag', /【风格:/.test(scenePrompt), false);

  // 道具提示词：必须带上所在环境（年代/材质/色调对齐）
  const propPrompt = svc.propImagePrompt(
    { name: '铁皮青蛙', type: '玩具', description: '掉漆的绿色铁皮青蛙' },
    false,
    STYLE,
    '「蛋蛋」=人物',
    {
      scriptExcerpt: propExcerpt,
      relatedScene: '老张家客厅（日）：低矮的土坯房',
      shotLines: ['分镜#2：手部特写，拇指按住发条'],
      charAnchors: ['「蛋蛋」黄色T恤'],
      refNames: ['场景图「老张家客厅」（仅用于对齐年代/材质/色调，不是要画的场景）'],
    },
  );
  eq('prop prompt carries script basis', propPrompt.includes('掉漆'), true);
  eq('prop prompt carries related scene', propPrompt.includes('土坯房'), true);
  eq('prop prompt aligns material with scene', propPrompt.includes('同材质'), true);
  eq('prop prompt declares scene ref not subject', propPrompt.includes('图1=场景图'), true);

  // 无上下文时不得凭空编造依据段（退化为仅有消歧串的旧行为）
  const bare = svc.sceneImagePrompt({ location: '客厅' }, false, STYLE, '「蛋蛋」=人物');
  eq('bare prompt has no fake script basis', bare.includes('剧本依据'), false);
  eq('bare prompt has no fake ref block', bare.includes('参考图对应关系'), false);
}

// ============ 成片规格：建项目时定，全流程唯一真相源 ============
// 回归重点：生图/生视频画幅必须跟随项目规格，不能再硬编码 9:16，
// 否则「建项目选 16:9」只会在最后合成才生效，前面素材全是竖屏。
{
  eq('spec default is 9:16', parseOutputSpec(null).aspect_ratio, '9:16');
  eq('spec parses json string',
    parseOutputSpec('{"aspect_ratio":"16:9","frame_rate":24,"resolution":"720p"}'),
    { aspect_ratio: '16:9', frame_rate: 24, resolution: '720p' });
  eq('spec survives malformed json', parseOutputSpec('{oops').aspect_ratio, '9:16');
  eq('spec rejects bad ratio', parseOutputSpec({ aspect_ratio: '4:3' }).aspect_ratio, '9:16');
  eq('spec rejects bad fps', parseOutputSpec({ frame_rate: 999 }).frame_rate, 30);
  eq('spec rejects bad resolution', parseOutputSpec({ resolution: '4K' }).resolution, '1080p');

  const portrait = parseOutputSpec({ aspect_ratio: '9:16', resolution: '1080p' });
  const landscape = parseOutputSpec({ aspect_ratio: '16:9', resolution: '1080p' });
  // 画面内容类素材必须与成片画幅一致
  eq('image ratio follows spec portrait', imageRatioOf(portrait), '9:16');
  eq('image ratio follows spec landscape', imageRatioOf(landscape), '16:9');
  // 道具设定图恒 1:1（与画幅无关的设定图语义）
  eq('prop ratio stays 1:1', propRatioOf(landscape), '1:1');
  // 视频请求固定 720P（模型只有该档），最终分辨率由合成 upscale
  eq('video size stays 720P', videoSizeOf(landscape), '720P');

  eq('resolution 9:16 1080p', resolutionOf(portrait), [1080, 1920]);
  eq('resolution 16:9 1080p', resolutionOf(landscape), [1920, 1080]);
  eq('resolution 16:9 720p', resolutionOf({ ...landscape, resolution: '720p' }), [1280, 720]);
}

// ============ 全局配置：调度 + AI 合一 ============
// 回归重点：① 明文 Key 绝不能回传前端；② 前端回传脱敏串时不能把真 Key 冲掉。
{
  const root = path.join(os.tmpdir(), `lmd-cfg-${Date.now()}`);
  // AppConfigService 写 cwd/../data，所以必须 chdir 到一个「子目录」里，
  // 否则会写到共享的临时目录根下、被上一次运行的残留污染
  const dir = path.join(root, 'app');
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    const cfg = new AppConfigService();
    const realKey = 'sk-REALSECRET-1234567890';
    cfg.setAiConfigFromDisplay({
      defaultProvider: 'agnes',
      providers: { agnes: { apiKey: realKey, baseUrl: 'https://x/v1', models: { image: 'custom-image-model' } } },
      tts: { appId: 'app-1', token: 'tok-1', cluster: 'volcano_tts', defaultVoice: '' },
    });

    // 读取必须是脱敏的
    const shown: any = cfg.getAiConfigForDisplay();
    const shownKey = shown.providers.agnes.apiKey;
    eq('config never leaks raw key', shownKey.includes(realKey), false);
    eq('config masks key', shownKey.includes('****'), true);
    eq('config flags key as set', shown.providers.agnes.apiKeySet, true);
    eq('config masks tts token', shown.tts.token.includes('****'), true);
    eq('config exposes baseUrl', shown.providers.agnes.baseUrl, 'https://x/v1');
    // 自定义模型必须透传（未提交的能力回落默认）
    eq('config keeps custom model', shown.providers.agnes.models.image, 'custom-image-model');
    eq('config fills default models', shown.providers.agnes.models.text, 'agnes-2.5-flash');

    // 前端把脱敏串原样回传 → 真 Key 不能被覆盖
    cfg.setAiConfigFromDisplay(shown);
    eq('masked roundtrip keeps real key', cfg.getAiConfig().providers.agnes.apiKey, realKey);
    eq('masked roundtrip keeps model', cfg.getAiConfig().providers.agnes.models.image, 'custom-image-model');

    // 填了新 Key → 真正替换
    cfg.setAiConfigFromDisplay({ providers: { agnes: { apiKey: 'sk-NEW-999' } } });
    eq('new key replaces old', cfg.getAiConfig().providers.agnes.apiKey, 'sk-NEW-999');
    // 只改模型不影响 Key
    cfg.setAiConfigFromDisplay({ providers: { agnes: { models: { text: 'other-text' } } } });
    eq('model change keeps key', cfg.getAiConfig().providers.agnes.apiKey, 'sk-NEW-999');
    eq('model change applied', cfg.getAiConfig().providers.agnes.models.text, 'other-text');

    // 调度配置
    cfg.setScheduler({ max_image_concurrency: 7 });
    eq('scheduler persists', cfg.getScheduler().max_image_concurrency, 7);
    eq('scheduler keeps other defaults', cfg.getScheduler().max_video_concurrency, 2);
  } finally {
    process.chdir(cwd);
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

auditTests().then(() => {
  console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
});