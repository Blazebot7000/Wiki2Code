import { Controller } from '@nestjs/common';
import { MessagePattern } from '@nestjs/microservices';
import {
  AI_PATTERNS,
  type AiProviderId,
  type ReviewRequest,
} from '@org/contracts';
import { AiService } from './ai.service';
import { ReviewEngineService } from './review.service';
import { RewriteService } from './rewrite.service';

@Controller()
export class AiController {
  constructor(
    private readonly ai: AiService,
    private readonly review: ReviewEngineService,
    private readonly rewrite: RewriteService,
  ) {}

  @MessagePattern(AI_PATTERNS.PROVIDERS_LIST)
  listProviders() {
    return this.ai.listProviders();
  }

  @MessagePattern(AI_PATTERNS.PROVIDERS_VALIDATE)
  validate(payload: {
    provider: AiProviderId;
    apiKey?: string;
    baseUrl?: string;
  }) {
    return this.ai.validate(payload);
  }

  @MessagePattern(AI_PATTERNS.PROVIDERS_ADD)
  add(payload: {
    provider: AiProviderId;
    apiKey?: string;
    baseUrl?: string;
    label?: string;
  }) {
    return this.ai.add(payload);
  }

  @MessagePattern(AI_PATTERNS.PROVIDERS_REMOVE)
  remove(payload: { id: string }) {
    return this.ai.remove(payload.id);
  }

  @MessagePattern(AI_PATTERNS.PROVIDERS_SELECT)
  select(payload: { model: string; providerId?: string }) {
    return this.ai.select(payload);
  }

  @MessagePattern(AI_PATTERNS.MODELS_LIST)
  models() {
    return {
      ...this.ai.selection(),
      models: this.ai.models(),
    };
  }

  @MessagePattern(AI_PATTERNS.REVIEW_START)
  startReview(payload: ReviewRequest) {
    return this.review.start(payload);
  }

  @MessagePattern(AI_PATTERNS.REVIEW_JOB)
  getReviewJob(payload: { jobId: string }) {
    return this.review.get(payload.jobId);
  }

  @MessagePattern(AI_PATTERNS.REVIEW_CANCEL)
  cancelReview(payload: { jobId: string }) {
    return this.review.cancel(payload.jobId);
  }

  @MessagePattern(AI_PATTERNS.WIKI_REWRITE)
  rewriteWiki(payload: {
    repoId: string;
    pageSlug: string;
    highlightId: string;
    model: string;
  }) {
    return this.rewrite.rewriteBlock(payload);
  }

  @MessagePattern(AI_PATTERNS.DEV_PLAN)
  planFix(payload: {
    repoId: string;
    highlightId: string;
    model: string;
    dryRun?: boolean;
  }) {
    return this.rewrite.planCodeFix(payload);
  }
}
