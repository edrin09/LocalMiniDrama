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
import { EpisodeService } from './episode.service';
import { CreateEpisodeDto, UpdateEpisodeDto } from './dto/episode.dto';

@Controller('episodes')
export class EpisodeController {
  constructor(private readonly episodeService: EpisodeService) {}

  @Get()
  findAll(@Query('dramaId') dramaId?: string) {
    return this.episodeService.findAll(dramaId ? Number(dramaId) : undefined);
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.episodeService.findOne(id);
  }

  @Post()
  create(@Body() dto: CreateEpisodeDto) {
    return this.episodeService.create(dto);
  }

  // 一键导入整本剧本：按「第N集」拆分批量建分集 + 填剧本
  @Post('import-script')
  importScript(
    @Body() body: { dramaId: number; text?: string; mode?: 'append' | 'replace' },
  ) {
    return this.episodeService.importScript(body?.dramaId, {
      text: body?.text,
      mode: body?.mode,
    });
  }

  @Put(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateEpisodeDto) {
    return this.episodeService.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.episodeService.remove(id);
  }
}
