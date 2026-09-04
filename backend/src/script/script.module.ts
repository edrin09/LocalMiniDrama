import { Module } from '@nestjs/common';
import {
  CharacterController,
  SceneController,
  PropController,
  StoryboardController,
} from './script.controller';
import { ScriptService } from './script.service';

@Module({
  controllers: [
    CharacterController,
    SceneController,
    PropController,
    StoryboardController,
  ],
  providers: [ScriptService],
  exports: [ScriptService],
})
export class ScriptModule {}