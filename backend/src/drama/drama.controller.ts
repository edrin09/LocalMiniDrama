import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  ParseIntPipe,
  Put,
  Delete,
} from '@nestjs/common';
import { DramaService } from './drama.service';
import { CreateDramaDto, UpdateDramaDto } from './dto/drama.dto';

@Controller('dramas')
export class DramaController {
  constructor(private readonly dramaService: DramaService) {}

  @Get()
  findAll() {
    return this.dramaService.findAll();
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.dramaService.findOne(id);
  }

  @Post()
  create(@Body() dto: CreateDramaDto) {
    return this.dramaService.create(dto);
  }

  @Put(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateDramaDto) {
    return this.dramaService.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.dramaService.remove(id);
  }
}