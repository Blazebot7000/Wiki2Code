import { Module } from '@nestjs/common';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { ReviewEngineService } from './review.service';
import { RewriteService } from './rewrite.service';

@Module({
  controllers: [AiController],
  providers: [AiService, ReviewEngineService, RewriteService],
})
export class AppModule {}
