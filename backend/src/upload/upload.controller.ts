import { BadRequestException, Body, Controller, Post } from '@nestjs/common';
import { StorageService } from '../ai/storage.service';
import { PromptService } from '../ai/prompt.service';

/**
 * 参考图上传与描述提取（计划 §①②③④ 「上传参考图」收尾项）
 * - POST /upload/image：dataUri 落盘 data/uploads/{dramaId}/{episodeId}/，返回可访问 url
 *   角色（整剧共享）落 {dramaId}/0/ 目录；
 * - POST /upload/extract-description：Agnes 多模态提取外貌/场景/道具描述，
 *   未配置 Key 或失败返回 null，由前端兜底提示手动填写。
 */
@Controller('upload')
export class UploadController {
  private static readonly EXT_BY_MIME: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
  };

  constructor(
    private readonly storage: StorageService,
    private readonly prompt: PromptService,
  ) {}

  @Post('image')
  async uploadImage(
    @Body() body: { dataUri?: string; kind?: string; dramaId?: number; episodeId?: number },
  ) {
    const parsed = this.parseDataUri(body.dataUri);
    const dramaId = Number(body.dramaId);
    if (!dramaId) throw new BadRequestException('缺少 dramaId');
    const kind = ['character', 'scene', 'prop', 'storyboard'].includes(
      String(body.kind),
    )
      ? String(body.kind)
      : 'ref';
    // 角色属整剧共享，落 {dramaId}/0/；其余按分集目录
    const episodeKey =
      kind === 'character' ? 0 : Number(body.episodeId) || 0;

    const asset = await this.storage.saveImage(dramaId, episodeKey, `ref-${kind}-${Date.now()}.${parsed.ext}`, {
      b64: parsed.b64,
    });
    return { url: asset.url, kind, dramaId, episodeId: episodeKey };
  }

  @Post('extract-description')
  async extractDescription(
    @Body() body: { dataUri?: string; kind?: string },
  ) {
    const kind = String(body.kind);
    if (!['character', 'scene', 'prop'].includes(kind)) {
      throw new BadRequestException('kind 仅支持 character / scene / prop');
    }
    this.parseDataUri(body.dataUri); // 只做格式校验
    const description = await this.prompt.describeImage(
      String(body.dataUri),
      kind as 'character' | 'scene' | 'prop',
    );
    return { description };
  }

  /** data:image/xxx;base64,yyy → { ext, b64 } */
  private parseDataUri(dataUri?: string) {
    const m = /^data:(image\/(?:png|jpe?g|webp));base64,(.+)$/i.exec(
      String(dataUri || ''),
    );
    if (!m) throw new BadRequestException('dataUri 必须是 png/jpg/webp 的 base64 图片');
    const mime = m[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : m[1].toLowerCase();
    const ext = UploadController.EXT_BY_MIME[mime];
    return { ext, b64: m[2] };
  }
}
