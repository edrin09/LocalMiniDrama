import {
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsDateString,
} from 'class-validator';

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
  @IsInt()
  seed?: number;

  @IsOptional()
  @IsDateString()
  createdAt?: string;
}