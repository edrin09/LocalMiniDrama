import { IsBoolean, IsInt, IsNumber, IsOptional, IsString } from 'class-validator';

export class CreateEpisodeDto {
  @IsInt()
  dramaId: number;

  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsInt()
  episodeNumber?: number;
}

export class UpdateEpisodeDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsInt()
  episodeNumber?: number;

  @IsOptional()
  @IsNumber()
  duration?: number;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsBoolean()
  merged?: boolean;

  @IsOptional()
  @IsString()
  mergeCfg?: string;

  @IsOptional()
  @IsString()
  genCfg?: string;

  @IsOptional()
  @IsString()
  scriptText?: string;
}
