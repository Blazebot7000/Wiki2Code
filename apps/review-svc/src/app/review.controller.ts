import { Controller } from '@nestjs/common';
import { MessagePattern } from '@nestjs/microservices';
import {
  REVIEW_PATTERNS,
  type Highlight,
  type ReviewJob,
} from '@org/contracts';
import { ReviewService } from './review.service';

@Controller()
export class ReviewController {
  constructor(private readonly reviews: ReviewService) {}

  @MessagePattern(REVIEW_PATTERNS.HIGHLIGHTS_LIST)
  listHighlights(payload: { repoId: string; pageSlug?: string }) {
    return this.reviews.listHighlights(payload.repoId, payload.pageSlug);
  }

  @MessagePattern(REVIEW_PATTERNS.HIGHLIGHTS_GET)
  getHighlight(payload: { id: string }) {
    return this.reviews.getHighlight(payload.id) ?? null;
  }

  @MessagePattern(REVIEW_PATTERNS.HIGHLIGHTS_REPLACE_PAGE)
  replacePage(payload: {
    repoId: string;
    pageSlug: string;
    highlights: Omit<Highlight, 'id' | 'createdAt' | 'updatedAt'>[];
  }) {
    return this.reviews.replacePage(payload);
  }

  @MessagePattern(REVIEW_PATTERNS.HIGHLIGHTS_UPDATE)
  updateHighlight(payload: {
    id: string;
    patch: Partial<Highlight>;
  }) {
    return this.reviews.updateHighlight(payload.id, payload.patch) ?? null;
  }

  @MessagePattern(REVIEW_PATTERNS.HIGHLIGHTS_MARK_STALE)
  markStale(payload: { repoId: string; paths: string[]; commitSha: string }) {
    return { changed: this.reviews.markStale(payload) };
  }

  @MessagePattern(REVIEW_PATTERNS.HIGHLIGHTS_CLEAR_REPO)
  clearRepo(payload: { repoId: string }) {
    return this.reviews.clearRepo(payload.repoId);
  }

  @MessagePattern(REVIEW_PATTERNS.JOBS_CREATE)
  createJob(payload: ReviewJob) {
    return this.reviews.createJob(payload);
  }

  @MessagePattern(REVIEW_PATTERNS.JOBS_UPDATE)
  updateJob(payload: { id: string; patch: Partial<ReviewJob> }) {
    return this.reviews.updateJob(payload.id, payload.patch) ?? null;
  }

  @MessagePattern(REVIEW_PATTERNS.JOBS_GET)
  getJob(payload: { id: string }) {
    return this.reviews.getJob(payload.id) ?? null;
  }

  @MessagePattern(REVIEW_PATTERNS.JOBS_LIST)
  listJobs(payload: { repoId: string }) {
    return this.reviews.listJobs(payload.repoId);
  }

  @MessagePattern(REVIEW_PATTERNS.STATE_VERSION)
  stateVersion(payload: { repoId: string }) {
    return this.reviews.stateVersion(payload.repoId);
  }
}
