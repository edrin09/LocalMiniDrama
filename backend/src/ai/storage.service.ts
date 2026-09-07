import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

export interface StoredAsset {
  /** 前端可直接访问的本地路径，如 /uploads/12/7/char-3.png */
  url: string;
  /** 磁盘绝对路径 */
  abs: string;
  /** 远端原始地址（若素材来自远端） */
  remote?: string;
}

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
};

/**
 * 素材落盘：data/uploads/{dramaId}/{episodeId}/
 * 生成产物统一先落本地（前端预览稳定可访问），同时保留远端原始 URL，
 * 供视频接口 keyframe 使用（Agnes 要求媒体地址可公开访问）。
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);

  private get root(): string {
    return path.resolve(process.cwd(), process.env.UPLOAD_DIR || '../data/uploads');
  }

  private dirOf(dramaId: number, episodeId: number) {
    return path.join(this.root, String(dramaId), String(episodeId));
  }

  /** 保存图片：远端 URL 或 base64 均可 */
  async saveImage(
    dramaId: number,
    episodeId: number,
    filename: string,
    input: { url?: string; b64?: string },
  ): Promise<StoredAsset> {
    const ext = path.extname(filename) || '.png';
    const name = filename.endsWith(ext) ? filename : `${filename}${ext}`;
    const dir = this.dirOf(dramaId, episodeId);
    await fs.promises.mkdir(dir, { recursive: true });
    const abs = path.join(dir, name);

    if (input.b64) {
      await fs.promises.writeFile(abs, Buffer.from(input.b64, 'base64'));
      return { url: this.publicPath(dramaId, episodeId, name), abs };
    }
    if (!input.url) throw new Error('saveImage 需要 url 或 b64');

    if (input.url.startsWith('data:')) {
      const base64 = input.url.slice(input.url.indexOf(',') + 1);
      await fs.promises.writeFile(abs, Buffer.from(base64, 'base64'));
      return { url: this.publicPath(dramaId, episodeId, name), abs };
    }

    try {
      const res = await fetch(input.url, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(`下载素材失败 ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      await fs.promises.writeFile(abs, buf);
    } catch (e: any) {
      this.logger.warn(`素材落盘失败，回退为远端直链：${e.message}`);
      return { url: input.url, abs: '', remote: input.url };
    }
    return {
      url: this.publicPath(dramaId, episodeId, name),
      abs,
      remote: input.url,
    };
  }

  async saveVideo(
    dramaId: number,
    episodeId: number,
    filename: string,
    input: { url?: string; b64?: string },
  ): Promise<StoredAsset> {
    return this.saveImage(dramaId, episodeId, filename, input);
  }

  /** 保存 TTS 配音音轨（mp3/wav/m4a），落盘到本地 uploads 目录 */
  async saveAudio(
    dramaId: number,
    episodeId: number,
    filename: string,
    input: { url?: string; b64?: string },
  ): Promise<StoredAsset> {
    return this.saveImage(dramaId, episodeId, filename, input);
  }

  /** 本地路径 → 可被 Agnes 访问的绝对地址（需配置 PUBLIC_BASE_URL，如内网穿透地址） */
  absoluteUrl(localOrRemote?: string | null): string | null {
    if (!localOrRemote) return null;
    if (/^https?:\/\//i.test(localOrRemote)) return localOrRemote;
    const base = process.env.PUBLIC_BASE_URL;
    if (!base) return null;
    return `${base.replace(/\/$/, '')}${localOrRemote}`;
  }

  /** 读取本地素材为 Data URI（图生图参考图，Agnes 支持 Data URI 输入） */
  async toDataUri(abs: string): Promise<string | null> {
    if (!abs || !fs.existsSync(abs)) return null;
    const buf = await fs.promises.readFile(abs);
    const mime = MIME_BY_EXT[path.extname(abs).toLowerCase()] || 'image/png';
    return `data:${mime};base64,${buf.toString('base64')}`;
  }

  private publicPath(dramaId: number, episodeId: number, name: string) {
    return `/uploads/${dramaId}/${episodeId}/${name}`;
  }

  /** 本地 /uploads/... 路径 → 磁盘绝对路径 */
  absFromUrl(localUrl?: string | null): string | null {
    if (!localUrl) return null;
    if (/^https?:\/\//i.test(localUrl)) return null;
    if (!localUrl.startsWith('/uploads/')) return null;
    return path.join(this.root, localUrl.replace(/^\/uploads\//, ''));
  }

  /** 成片输出位置（返回可访问 url 与绝对路径） */
  mergeOutput(dramaId: number, episodeId: number, ext = 'mp4') {
    const dir = this.dirOf(dramaId, episodeId);
    const name = `merged.${ext}`;
    return { url: this.publicPath(dramaId, episodeId, name), abs: path.join(dir, name) };
  }

  /** 规整片段临时目录 */
  workDir(dramaId: number, episodeId: number) {
    return this.dirOf(dramaId, episodeId);
  }

  /**
   * 物理删除目录（递归）。
   * 必须用 Node 自带 fs.rmSync：直接 spawn `rmdir` 在 Windows 上必然 ENOENT
   * （rmdir 是 cmd 内部命令而非可执行文件），且曾被 catch 静默吞掉，
   * 导致「重置」从未真正删除过任何文件。
   */
  private purgeDir(dir: string): void {
    // 安全护栏：只允许删除 uploads 内部目录，且禁止删除 uploads 根目录本身，
    // 防止误删项目其他文件。
    const absRoot = path.resolve(this.root);
    const absDir = path.resolve(dir);
    if (absDir === absRoot || !absDir.startsWith(absRoot + path.sep)) {
      this.logger.warn(`拒绝删除目录（超出安全范围）：${dir}`);
      return;
    }
    try {
      fs.rmSync(absDir, { recursive: true, force: true });
    } catch (e: any) {
      this.logger.warn(`目录删除失败：${dir}（${e?.message ?? e}）`);
    }
  }

  /** 物理删除已不被记录引用的本地素材文件（远端 URL / 不存在则跳过，失败不抛出） */
  async removeLocalFiles(urls: Array<string | null | undefined>): Promise<void> {
    for (const u of urls) {
      const abs = this.absFromUrl(u ?? null);
      if (!abs) continue;
      try {
        await fs.promises.rm(abs, { force: true });
      } catch {
        /* 清理失败不阻塞生成主流程 */
      }
    }
  }

  /** 物理删除某分集的全部生成文件（图片/视频/音频/成片），不可逆 */
  async removeEpisodeDir(dramaId: number, episodeId: number): Promise<void> {
    this.purgeDir(this.dirOf(dramaId, episodeId));
  }

  /** 物理删除整剧的生成文件目录，不可逆 */
  async removeDramaDir(dramaId: number): Promise<void> {
    this.purgeDir(path.join(this.root, String(dramaId)));
  }
}
