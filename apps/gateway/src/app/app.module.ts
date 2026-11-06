import { Module } from '@nestjs/common';
import { Clients } from './clients';
import { GithubController } from './github.controller';
import { ReviewController } from './review.controller';
import { SetupController } from './setup.controller';

@Module({
  controllers: [SetupController, GithubController, ReviewController],
  providers: [Clients],
})
export class AppModule {}
