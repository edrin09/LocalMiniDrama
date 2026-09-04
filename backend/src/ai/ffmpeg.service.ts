import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { existsSync } from 'fs';

export interface ProbeResult {
  duration: number; // 秒
  width: number;
  height: number;
  hasAudio: boolean;
  fps: number;
}

export interface NormalizeInput {
  video: string; // 主视频（分镜视频）
  audio?: string; // 对白 TTS 音轨（可选）
  narration?: string; // 旁白 TTS 音轨（可选）
  targetW: number;
  targetH: number;
  fps: number;
  out: string;
  /**
   * 旋转校正：AI 视频偶发像素被旋转 90°（容器元数据仍 portrait，但像素躺平）。
   * 1 = 顺时针 90°；2 = 逆时针 90°。校正后 video 流会先 transpose 再 scale/pad，
   * 目标尺寸需要自动互换以保持最终的画幅比例。
   */
  transpose?: 1 | 2;
}

/**
 * ffmpeg 封装：尾帧提取 + 整片合成所需的探测 / 规整 / 混音 / 拼接。
 *
 * 音频完整性原则（开发文档 §ffmpeg）：
 *  - 对白 + 旁白按 duration=longest 完整保留，绝不压缩音频速度；
 *  - 音轨长于视频时把末帧冻结（tpad）补足；
 *  - 视频长于音轨时用静音（apad）补足，保证音画同步且声轨完整。
 */
@Injectable()
export class FfmpegService {
  private readonly logger = new Logger(FfmpegService.name);

  /** 完整版 ffmpeg 路径：优先 FFMPEG_PATH（.env），缺省走 PATH（注意 PATH 首位可能是精简版） */
  private readonly ffmpegBin: string;
  private readonly ffprobeBin: string;

  constructor() {
    const custom = process.env.FFMPEG_PATH?.trim();
    this.ffmpegBin = custom || 'ffmpeg';
    this.ffprobeBin = custom
      ? custom.replace(/ffmpeg\.exe$/i, 'ffprobe.exe')
      : 'ffprobe';
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.run(['-version'], 10_000);
      return true;
    } catch {
      return false;
    }
  }

  /** 取视频最后一帧写入 outAbs，成功返回 true */
  async extractLastFrame(videoAbs: string, outAbs: string): Promise<boolean> {
    try {
      await this.run(
        ['-y', '-sseof', '-0.15', '-i', videoAbs, '-frames:v', '1', '-q:v', '2', outAbs],
        60_000,
      );
      return true;
    } catch (e: any) {
      this.logger.warn(`提取尾帧失败：${e.message}`);
      return false;
    }
  }

  /** 取视频第 1 帧（用 0.1s 跳过黑场），用于旋转检测等对比 */
  async extractFirstFrame(videoAbs: string, outAbs: string): Promise<boolean> {
    try {
      await this.run(
        ['-y', '-ss', '0.1', '-i', videoAbs, '-frames:v', '1', '-q:v', '3', outAbs],
        60_000,
      );
      return existsSync(outAbs);
    } catch (e: any) {
      this.logger.warn(`提取首帧失败：${e.message}`);
      return false;
    }
  }

  /** 探测视频基础信息（使用 ffprobe） */
  async probe(path: string): Promise<ProbeResult> {
    const out = await this.runBin(this.ffprobeBin,
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration:stream=width,height,r_frame_rate,codec_type',
        '-of',
        'json',
        path,
      ],
      30_000,
    );
    const info = JSON.parse(out);
    const dur = parseFloat(info?.format?.duration ?? '0') || 0;
    const v = (info?.streams ?? []).find((s: any) => s.codec_type === 'video');
    const a = (info?.streams ?? []).find((s: any) => s.codec_type === 'audio');
    let fps = 0;
    if (v?.r_frame_rate) {
      const [n, d] = v.r_frame_rate.split('/').map(Number);
      if (d) fps = n / d;
    }
    return {
      duration: dur,
      width: Number(v?.width ?? 0),
      height: Number(v?.height ?? 0),
      hasAudio: !!a,
      fps: Math.round(fps) || 0,
    };
  }

  /**
   * 规整单个分镜片段：
   *  - 统一分辨率（黑边填充，保持比例）+ 帧率 + yuv420p
   *  - 对白/旁白音轨合并（duration=longest），无独立音轨则保留原声
   *  - 音轨长于视频：末帧冻结补足；视频长于音轨：静音补足
   */
  async normalizeSegment(input: NormalizeInput): Promise<boolean> {
    try {
      const { video, audio, narration, targetW, targetH, fps, out, transpose } = input;
      const vInfo = await this.probe(video);
      const vDur = vInfo.duration || 0;

      const audioFiles: string[] = [];
      if (audio && existsSync(audio)) audioFiles.push(audio);
      if (narration && existsSync(narration)) audioFiles.push(narration);

      // 计算合并后音轨时长
      let aDur = 0;
      if (audioFiles.length) {
        const durs = await Promise.all(audioFiles.map((f) => this.probe(f)));
        aDur = Math.max(...durs.map((d) => d.duration || 0));
      }

      const segDur = Math.max(vDur, aDur);
      const inputs = [video, ...audioFiles];

      // 视频滤镜：可选旋转校正 → 帧率 → 缩放填充 → 末帧冻结补足
      // transpose 后画面宽高互换，所以 scale/pad 目标也要互换
      const effW = transpose ? targetH : targetW;
      const effH = transpose ? targetW : targetH;
      let vFilter = `[0:v]`;
      if (transpose === 1 || transpose === 2) {
        vFilter += `transpose=${transpose},`;
      }
      vFilter += `fps=${fps},scale=${effW}:${effH}:force_original_aspect_ratio=decrease,pad=${effW}:${effH}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
      if (aDur > vDur + 0.05) {
        vFilter += `,tpad=stop_mode=add:stop_duration=${(aDur - vDur).toFixed(3)}`;
      }
      vFilter += '[v]';

      // 音频滤镜
      let aFilter: string;
      if (audioFiles.length) {
        const labels = audioFiles.map((_, i) => `${i + 1}:a`).join('');
        aFilter = `[${labels}]amix=inputs=${audioFiles.length}:duration=longest:dropout_transition=0[a0];[a0]apad=whole_dur=${segDur.toFixed(3)}[a]`;
      } else if (vInfo.hasAudio) {
        aFilter = `[0:a]apad=whole_dur=${segDur.toFixed(3)}[a]`;
      } else {
        // 无音轨则补静音
        aFilter = `anullsrc=channel_layout=stereo:sample_rate=44100:duration=${segDur.toFixed(3)}[a]`;
      }

      const args = [
        '-y',
        ...inputs.flatMap((f) => ['-i', f]),
        '-filter_complex',
        `${vFilter};${aFilter}`,
        '-map',
        '[v]',
        '-map',
        '[a]',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-preset',
        'veryfast',
        '-c:a',
        'aac',
        '-ar',
        '44100',
        '-r',
        String(fps),
        out,
      ];
      await this.run(args, 180_000);
      return existsSync(out);
    } catch (e: any) {
      this.logger.warn(`规整片段失败：${e.message}`);
      return false;
    }
  }

  /** 生成一段纯色静音垫片（用于缺片段时补位） */
  async buildSilentClip(
    out: string,
    durationSec: number,
    targetW: number,
    targetH: number,
    fps: number,
    color = 'black',
  ): Promise<boolean> {
    try {
      await this.run(
        [
          '-y',
          '-f',
          'lavfi',
          '-i',
          `color=c=${color}:s=${targetW}x${targetH}:r=${fps}:d=${durationSec.toFixed(2)}`,
          '-f',
          'lavfi',
          '-i',
          `anullsrc=channel_layout=stereo:sample_rate=44100:d=${durationSec.toFixed(2)}`,
          '-c:v',
          'libx264',
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'aac',
          '-t',
          durationSec.toFixed(2),
          out,
        ],
        60_000,
      );
      return existsSync(out);
    } catch (e: any) {
      this.logger.warn(`生成静音垫片失败：${e.message}`);
      return false;
    }
  }

  /** 拼接多个已规整的片段为成片 */
  async concatSegments(segments: string[], out: string): Promise<boolean> {
    try {
      const list = segments.map((s) => `file '${s.replace(/'/g, "'\\''")}'`).join('\n');
      await this.run(
        ['-y', '-f', 'concat', '-safe', '0', '-protocol_whitelist', 'file,pipe', '-i', 'pipe:0', '-c', 'copy', out],
        300_000,
        list,
      );
      return existsSync(out);
    } catch (e: any) {
      this.logger.warn(`拼接片段失败：${e.message}`);
      return false;
    }
  }

  run(args: string[], timeoutMs = 120_000, stdin?: string): Promise<string> {
    return this.runBin(this.ffmpegBin, args, timeoutMs, stdin);
  }

  runBin(bin: string, args: string[], timeoutMs = 120_000, stdin?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        bin,
        args,
        { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            reject(new Error(stderr?.toString().slice(-600) || err.message));
            return;
          }
          resolve(stdout?.toString() ?? '');
        },
      );
      if (stdin) child.stdin?.write(stdin), child.stdin?.end();
    });
  }
}
