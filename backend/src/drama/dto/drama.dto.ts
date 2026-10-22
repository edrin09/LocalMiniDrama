import {
  IsInt,
  IsIn,
  IsOptional,
  IsString,
  IsDateString,
  IsObject,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * 成片规格：建项目时确定，之后生图 / 生视频 / 合成共用同一份。
 * 关键约束（此前违反过）：画幅必须从第一步就贯穿 —— 若素材按 9:16 生成、
 * 到合成才切成 16:9，只会被压成窄条或加黑边，所以这里必须是唯一真相源。
 */
export class OutputCfgDto {
  @IsIn(['9:16', '16:9'])
  aspect_ratio: '9:16' | '16:9';

  @IsIn([24, 25, 30, 60])
  frame_rate: number;

  @IsIn(['720p', '1080p'])
  resolution: '720p' | '1080p';
}

export class CreateDramaDto {
  @IsString()
  title: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  dialect?: string;

  @IsOptional()
  @IsString()
  coverStyle?: string;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => OutputCfgDto)
  outputCfg?: OutputCfgDto;

  @IsOptional()
  @IsInt()
  seed?: number;
}

export class UpdateDramaDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  dialect?: string;

  @IsOptional()
  @IsString()
  coverStyle?: string;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => OutputCfgDto)
  outputCfg?: OutputCfgDto;

  @IsOptional()
  @IsInt()
  seed?: number;

  @IsOptional()
  @IsDateString()
  createdAt?: string;
}