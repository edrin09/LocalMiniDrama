import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  ParseIntPipe,
  Put,
  Delete,
  Query,
} from '@nestjs/common';
import { ScriptService } from './script.service';
import {
  CreateCharacterDto,
  UpdateCharacterDto,
  CreateSceneDto,
  UpdateSceneDto,
  CreatePropDto,
  UpdatePropDto,
  CreateStoryboardDto,
  UpdateStoryboardDto,
} from './dto/script.dto';

@Controller('characters')
export class CharacterController {
  constructor(private readonly script: ScriptService) {}
  @Get()
  list(@Query('dramaId') dramaId?: string) {
    return this.script.listCharacters(dramaId ? Number(dramaId) : undefined);
  }
  @Post()
  create(@Body() dto: CreateCharacterDto) {
    return this.script.createCharacter(dto);
  }
  @Put(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateCharacterDto) {
    return this.script.updateCharacter(id, dto);
  }
  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.script.deleteCharacter(id);
  }
}

@Controller('scenes')
export class SceneController {
  constructor(private readonly script: ScriptService) {}
  @Get()
  list(@Query('episodeId') episodeId?: string) {
    return this.script.listScenes(episodeId ? Number(episodeId) : undefined);
  }
  @Post()
  create(@Body() dto: CreateSceneDto) {
    return this.script.createScene(dto);
  }
  @Put(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateSceneDto) {
    return this.script.updateScene(id, dto);
  }
  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.script.deleteScene(id);
  }
}

@Controller('props')
export class PropController {
  constructor(private readonly script: ScriptService) {}
  @Get()
  list(@Query('episodeId') episodeId?: string) {
    return this.script.listProps(episodeId ? Number(episodeId) : undefined);
  }
  @Post()
  create(@Body() dto: CreatePropDto) {
    return this.script.createProp(dto);
  }
  @Put(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdatePropDto) {
    return this.script.updateProp(id, dto);
  }
  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.script.deleteProp(id);
  }
}

@Controller('storyboards')
export class StoryboardController {
  constructor(private readonly script: ScriptService) {}
  @Get()
  list(@Query('episodeId') episodeId?: string) {
    return this.script.listStoryboards(episodeId ? Number(episodeId) : undefined);
  }
  @Post()
  create(@Body() dto: CreateStoryboardDto) {
    return this.script.createStoryboard(dto);
  }
  @Put(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateStoryboardDto) {
    return this.script.updateStoryboard(id, dto);
  }
  @Put(':episodeId/reorder')
  reorder(
    @Param('episodeId', ParseIntPipe) episodeId: number,
    @Body('ids') ids: number[],
  ) {
    return this.script.reorderStoryboards(episodeId, ids);
  }
  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.script.deleteStoryboard(id);
  }
}