import {
  IsArray,
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
} from 'class-validator';

// ===== 角色（整剧共享，dramaId 归属） =====
export class CreateCharacterDto {
  @IsInt()
  dramaId: number;

  @IsString()
  name: string;

  @IsOptional() @IsString() dialect?: string;
  @IsOptional() @IsString() role?: string;
  @IsOptional() @IsString() roleLabel?: string;
  @IsOptional() @IsString() appearance?: string;
  @IsOptional() @IsString() anchors?: string;
  @IsOptional() @IsString() imageUrl?: string;
  @IsOptional() @IsString() referenceImageUrl?: string;
  @IsOptional() @IsString() intro?: string;
}

export class UpdateCharacterDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() dialect?: string;
  @IsOptional() @IsString() role?: string;
  @IsOptional() @IsString() roleLabel?: string;
  @IsOptional() @IsString() appearance?: string;
  @IsOptional() @IsString() anchors?: string;
  @IsOptional() @IsString() imageUrl?: string;
  @IsOptional() @IsString() referenceImageUrl?: string;
  @IsOptional() @IsString() intro?: string;
}

// ===== 场景（分集归属） =====
export class CreateSceneDto {
  @IsInt()
  episodeId: number;

  @IsString()
  location: string;

  @IsOptional() @IsString() time?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() prompt?: string;
  @IsOptional() @IsString() quadPrompt?: string;
  @IsOptional() @IsString() imageUrl?: string;
  @IsOptional() @IsString() referenceImageUrl?: string;
  @IsOptional() @IsBoolean() useQuadGrid?: boolean;
}

export class UpdateSceneDto {
  @IsOptional() @IsString() location?: string;
  @IsOptional() @IsString() time?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() prompt?: string;
  @IsOptional() @IsString() quadPrompt?: string;
  @IsOptional() @IsString() imageUrl?: string;
  @IsOptional() @IsString() referenceImageUrl?: string;
  @IsOptional() @IsBoolean() useQuadGrid?: boolean;
}

// ===== 道具（分集归属） =====
export class CreatePropDto {
  @IsInt()
  episodeId: number;

  @IsString()
  name: string;

  @IsOptional() @IsString() type?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() prompt?: string;
  @IsOptional() @IsString() imageUrl?: string;
  @IsOptional() @IsString() referenceImageUrl?: string;
  @IsOptional() @IsBoolean() useQuadGrid?: boolean;
}

export class UpdatePropDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() type?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() prompt?: string;
  @IsOptional() @IsString() imageUrl?: string;
  @IsOptional() @IsString() referenceImageUrl?: string;
  @IsOptional() @IsBoolean() useQuadGrid?: boolean;
}

// ===== 分镜（分集归属） =====
export class CreateStoryboardDto {
  @IsInt()
  episodeId: number;

  @IsOptional() @IsInt() number?: number;
  @IsOptional() @IsInt() characterId?: number;
  @IsOptional() @IsArray() characterIds?: number[];
  @IsOptional() @IsInt() sceneId?: number;
  @IsOptional() @IsInt() propId?: number;
  @IsOptional() @IsArray() propIds?: number[];
  @IsOptional() @IsString() dialogue?: string;
  @IsOptional() @IsString() narration?: string;
  @IsOptional() @IsString() sceneDescription?: string;
  @IsOptional() @IsString() motionDescription?: string;
  @IsOptional() @IsString() emotion?: string;
  @IsOptional() @IsNumber() duration?: number;
  @IsOptional() @IsString() dialect?: string;
  @IsOptional() @IsString() imageUrl?: string;
  @IsOptional() @IsString() lastFrameUrl?: string;
  @IsOptional() @IsString() videoUrl?: string;
  @IsOptional() @IsString() referenceImageUrl?: string;
  @IsOptional() @IsString() status?: string;
}

export class UpdateStoryboardDto {
  @IsOptional() @IsInt() number?: number;
  @IsOptional() @IsInt() characterId?: number;
  @IsOptional() @IsArray() characterIds?: number[];
  @IsOptional() @IsInt() sceneId?: number;
  @IsOptional() @IsInt() propId?: number;
  @IsOptional() @IsArray() propIds?: number[];
  @IsOptional() @IsString() dialogue?: string;
  @IsOptional() @IsString() narration?: string;
  @IsOptional() @IsString() sceneDescription?: string;
  @IsOptional() @IsString() motionDescription?: string;
  @IsOptional() @IsString() emotion?: string;
  @IsOptional() @IsNumber() duration?: number;
  @IsOptional() @IsString() dialect?: string;
  @IsOptional() @IsString() imageUrl?: string;
  @IsOptional() @IsString() lastFrameUrl?: string;
  @IsOptional() @IsString() videoUrl?: string;
  @IsOptional() @IsString() referenceImageUrl?: string;
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsString() imagePrompt?: string;
  @IsOptional() @IsString() videoPrompt?: string;
}