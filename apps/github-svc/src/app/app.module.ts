import { Module } from '@nestjs/common';
import { DevCycleService } from './devcycle.service';
import { GithubAuthService } from './github-auth.service';
import { GithubController } from './github.controller';
import { GithubReposService } from './github-repos.service';

@Module({
  controllers: [GithubController],
  providers: [GithubAuthService, GithubReposService, DevCycleService],
})
export class AppModule {}
