/**
 * 集成测试：在数据库副本上跑真实 applyParsed / reorderStoryboards / deleteStoryboard，
 * 覆盖「append 编号撞号」「重排跨分集 id」「删除后编号连续」等仅靠类型检查发现不了的问题。
 * 绝不触碰 data/lmd.db 本体，只用临时副本。
 *
 * 【正式测试入口】已挂到 package.json：
 *   npm run test:integration   # 仅本文件
 * 退出码 0 = 全部通过，1 = 有失败项。
 */
import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmpDb = path.join(os.tmpdir(), `lmd-test-${Date.now()}.db`);
const src = path.join(__dirname, '..', '..', 'data', 'lmd.db');
if (!fs.existsSync(src)) {
  console.log('SKIP: 找不到 data/lmd.db，跳过集成验证');
  process.exit(0);
}
fs.copyFileSync(src, tmpDb);
process.env.DATABASE_URL = `file:${tmpDb.replace(/\\/g, '/')}`;

import { ScriptService } from '../src/script/script.service';
import { GenerateService } from '../src/generate/generate.service';

let fail2 = 0;
const eq2 = (name: string, got: any, want: any) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fail2++; console.log(`FAIL ${name}\n  got : ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`); }
  else console.log(`ok   ${name}`);
};

const episodeArg = (id: number, dramaId: number, title: string) => ({
  id, title, description: null, scriptText: 'x', dramaId,
  drama: { id: dramaId, title: '集成验证剧', dialect: null },
});

const mkParsed = () => ({
  characters: [{ name: '老爸', role: 'main', roleLabel: '父亲', appearance: '方脸，蓝色马甲', intro: '父亲' }],
  scenes: [{ location: '客厅', time: '白天', description: '沙发茶几' }],
  props: [{ name: '手机', type: null, description: '黑色手机' }],
  storyboards: [
    { characters: ['老爸'], character: '老爸', scene: '客厅', prop: '手机', dialogue: '你回来了', narration: null,
      sceneDescription: '中景老爸推门', motionDescription: '镜头缓慢推近', emotion: 'neutral', duration: 5 },
    { characters: ['老爸'], character: '老爸', scene: '客厅', prop: '', dialogue: '回来了', narration: null,
      sceneDescription: '近景老爸侧脸', motionDescription: '', emotion: 'happy', duration: 5 },
  ],
});

async function main() {
  const prisma = new PrismaClient();
  const script = new ScriptService(prisma);
  const gen: any = Object.create(GenerateService.prototype);
  gen.prisma = prisma;
  gen.storage = { removeEpisodeDir: async () => {} };
  gen.log = () => {};
  gen.fire = async () => {};
  gen.roleCtxCache = new Map();

  const drama = await prisma.drama.create({ data: { title: '集成验证剧', seed: 1 } });
  const ep = await prisma.episode.create({ data: { dramaId: drama.id, title: '第1集', episodeNumber: 1 } });
  const ep2 = await prisma.episode.create({ data: { dramaId: drama.id, title: '第2集', episodeNumber: 2 } });
  const epArg = episodeArg(ep.id, drama.id, '第1集');

  // 首次落库（replace）
  await gen.applyParsed(epArg, 'replace', mkParsed());
  let sbs = await prisma.storyboard.findMany({ where: { episodeId: ep.id }, orderBy: { number: 'asc' } });
  eq2('replace numbers 1..2', sbs.map((s: any) => s.number), [1, 2]);
  eq2('character attached', sbs[0].characterId != null, true);
  eq2('scene attached', sbs[0].sceneId != null, true);
  eq2('prop attached', sbs[0].propId != null, true);
  eq2('no duplicate scene rows', await prisma.scene.count({ where: { episodeId: ep.id } }), 1);

  // 关键回归：append 模式必须从 max(number)+1 继续，不能与已有分镜撞号
  await gen.applyParsed(epArg, 'append', mkParsed());
  sbs = await prisma.storyboard.findMany({ where: { episodeId: ep.id }, orderBy: { number: 'asc' } });
  eq2('append numbers continue', sbs.map((s: any) => s.number), [1, 2, 3, 4]);
  eq2('append no duplicate numbers', new Set(sbs.map((s: any) => s.number)).size, 4);
  eq2('append reuses character row', await prisma.character.count({ where: { dramaId: drama.id } }), 1);
  eq2('append reuses scene row', await prisma.scene.count({ where: { episodeId: ep.id } }), 1);
  eq2('append reuses prop row', await prisma.prop.count({ where: { episodeId: ep.id } }), 1);

  // 模糊名称匹配：AI 返回带空格/标点的名字也要挂得上
  await gen.applyParsed(epArg, 'append', {
    ...mkParsed(),
    storyboards: [{ characters: [' 老爸！'], character: '老爸！', scene: ' 客厅 ', prop: '', dialogue: '嗯',
      narration: null, sceneDescription: '特写', motionDescription: '', emotion: 'neutral', duration: 5 }],
  });
  const fuzzy = await prisma.storyboard.findFirst({ where: { episodeId: ep.id }, orderBy: { number: 'desc' } });
  eq2('fuzzy name matched character', fuzzy.characterId != null, true);
  eq2('fuzzy name matched scene', fuzzy.sceneId != null, true);

  // 重排必须拒绝不属于本分集的 id
  let threw = '';
  try { await script.reorderStoryboards(ep2.id, [sbs[0].id]); }
  catch (e: any) { threw = e.message; }
  eq2('reorder rejects foreign id', threw.includes('不属于本分集'), true);

  const all = await prisma.storyboard.findMany({ where: { episodeId: ep.id }, orderBy: { number: 'asc' } });
  await script.reorderStoryboards(ep.id, all.map((s: any) => s.id));
  const reordered = await prisma.storyboard.findMany({ where: { episodeId: ep.id }, orderBy: { number: 'asc' } });
  eq2('reorder renumbers 1..n', reordered.map((s: any) => s.number), [1, 2, 3, 4, 5]);

  // 删除后编号必须保持连续
  await script.deleteStoryboard(reordered[1].id);
  const afterDel = await prisma.storyboard.findMany({ where: { episodeId: ep.id, deletedAt: null }, orderBy: { number: 'asc' } });
  eq2('delete keeps numbers contiguous', afterDel.map((s: any) => s.number), [1, 2, 3, 4]);

  // 列表排序在编号有重复时也必须稳定（依赖二级排序键）
  await prisma.storyboard.update({ where: { id: afterDel[1].id }, data: { number: 1 } });
  const l1 = await script.listStoryboards(ep.id);
  const l2 = await script.listStoryboards(ep.id);
  eq2('list order stable with dup numbers', l1.map((s: any) => s.id).join(','), l2.map((s: any) => s.id).join(','));

  // ============ 时长自动校准（无需用户点按钮） ============
  const target = afterDel[0];
  const longLine = '这是一句非常长的台词'.repeat(6); // 72 字 → 远超 5s
  const bumped = await script.updateStoryboard(target.id, { dialogue: longLine, duration: 5 } as any);
  eq2('auto-fit raises too-short duration', bumped.duration > 5, true);
  eq2('auto-fit keeps duration within cap', bumped.duration <= 12, true);

  // 显式填更长值必须保留（情绪镜需要留白），不能被压回
  const kept = await script.updateStoryboard(target.id, { duration: 12 } as any);
  eq2('auto-fit respects explicit longer value', kept.duration, 12);

  // 只改台词、不传 duration 时也要重新校准（此前最容易漏掉的路径）
  await script.updateStoryboard(target.id, { duration: 4 } as any);
  const refit = await script.updateStoryboard(target.id, { dialogue: longLine } as any);
  eq2('auto-fit reruns when only dialogue changes', refit.duration > 4, true);

  // 无台词镜：不得被无故改动
  const empty = await script.updateStoryboard(target.id, { dialogue: '', narration: '', duration: 6 } as any);
  eq2('auto-fit leaves silent shot alone', empty.duration, 6);

  await prisma.$disconnect();
  try { fs.unlinkSync(tmpDb); } catch { /* ignore */ }
  console.log(fail2 === 0 ? '\nALL PASS (integration)' : `\n${fail2} FAILED (integration)`);
  process.exit(fail2 === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });