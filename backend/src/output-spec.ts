/**
 * 成片规格（画幅 / 帧率 / 清晰度）：全流程唯一真相源。
 *
 * 为什么必须提到建项目时定：
 * 此前生图与生视频全部硬编码 9:16，只有最后 ffmpeg 合成才读 mergeCfg.aspect_ratio。
 * 于是「先按 9:16 生成素材、最后一步切成 16:9」必然被压成窄条或加黑边 ——
 * 画幅是生成参数，不是后期裁切参数。规格一旦确定就必须贯穿
 * 生图 → 生视频 → 合成，任何一步偏离都会毁掉前面所有素材。
 */

/** 全流程共用的成片规格；落库在 Drama.outputCfg（JSON） */
export interface OutputSpec {
  aspect_ratio: '9:16' | '16:9';
  frame_rate: number;
  resolution: '720p' | '1080p';
}

/** 默认 9:16 / 30fps / 1080p（竖屏短剧最常见） */
export const DEFAULT_OUTPUT_SPEC: OutputSpec = {
  aspect_ratio: '9:16',
  frame_rate: 30,
  resolution: '1080p',
};

const RATIOS = ['9:16', '16:9'] as const;
const RESOLUTIONS = ['720p', '1080p'] as const;
const FPS = [24, 25, 30, 60];

/** 容错解析：非法值一律回落到默认，绝不让脏数据流到生成/合成链路 */
export function parseOutputSpec(raw?: string | null | object): OutputSpec {
  let obj: any = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      obj = null;
    }
  }
  if (!obj || typeof obj !== 'object') return { ...DEFAULT_OUTPUT_SPEC };
  return {
    aspect_ratio: RATIOS.includes(obj.aspect_ratio)
      ? obj.aspect_ratio
      : DEFAULT_OUTPUT_SPEC.aspect_ratio,
    frame_rate: FPS.includes(Number(obj.frame_rate))
      ? Number(obj.frame_rate)
      : DEFAULT_OUTPUT_SPEC.frame_rate,
    resolution: RESOLUTIONS.includes(obj.resolution)
      ? obj.resolution
      : DEFAULT_OUTPUT_SPEC.resolution,
  };
}

/**
 * 分镜首帧/尾帧与角色立绘/场景图的生图画幅。
 * 素材图必须与成片画幅一致：9:16 出 9:16、16:9 出 16:9，
 * 否则首帧塞进视频时会被 ffmpeg 缩放变形（这正是黑边/拉伸问题的来源）。
 */
export function imageRatioOf(spec: OutputSpec): string {
  return spec.aspect_ratio;
}

/** 道具设定图保持 1:1：它是与画幅无关的「设定图」语义，放进任何画幅都靠缩放而非裁切 */
export function propRatioOf(_spec: OutputSpec): string {
  return '1:1';
}

/**
 * 生视频请求的清晰度。
 * Agnes 视频模型只有 720P 档，最终分辨率由合成阶段 upscale 到 spec.resolution，
 * 因此这里固定 720P，避免用 1080P 请求被拒或凭空放大体积。
 */
export function videoSizeOf(_spec: OutputSpec): string {
  return '720P';
}

/**
 * resolution 文本 → 像素尺寸（偶数对齐）。
 *
 * 「1080p」指**短边** 1080（1920x1080 / 1080x1920），不是长边 1080。
 * 此前按长边取 1080，导致 16:9 算出 1080x608 这种非标准尺寸 ——
 * 竖屏恰好蒙对了（短边=长边），横屏才会暴露。
 */
export function resolutionOf(spec: OutputSpec): [number, number] {
  const [rw, rh] = spec.aspect_ratio.split(':').map(Number);
  const shortSide = spec.resolution === '1080p' ? 1080 : 720;
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  return rw >= rh
    ? [even((shortSide * rw) / rh), even(shortSide)]
    : [even(shortSide), even((shortSide * rh) / rw)];
}