import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Sse,
  type MessageEvent,
} from '@nestjs/common';
import {
  AI_PATTERNS,
  GITHUB_PATTERNS,
  REVIEW_PATTERNS,
  SYNC_PATTERNS,
  type DevCycleJob,
  type DevPlan,
  type Highlight,
  type HighlightStatus,
  type ModelInfo,
  type ReviewJob,
  type SyncState,
} from '@org/contracts';
import { sendTo } from '@org/server';
import { concatMap, from, interval, map, type Observable } from 'rxjs';
import { Clients } from './clients';

@Controller()
export class ReviewController {
  constructor(private readonly clients: Clients) {}

  @Post('repos/:repoId/reviews')
  async startReview(
    @Param('repoId') repoId: string,
    @Body()
    body: {
      model?: string;
      incremental?: boolean;
      changedPaths?: string[];
    },
  ): Promise<ReviewJob> {
    const model = body?.model ?? (await this.selectedModel());
    if (!model) {
      throw new BadRequestException(
        'Connect an AI provider before running a review.',
      );
    }
    return sendTo(this.clients.ai, AI_PATTERNS.REVIEW_START, {
      repoId,
      model,
      incremental: body?.incremental,
      changedPaths: body?.changedPaths,
    });
  }

  @Get('reviews/:jobId')
  getReview(@Param('jobId') jobId: string): Promise<ReviewJob | undefined> {
    return sendTo(this.clients.ai, AI_PATTERNS.REVIEW_JOB, { jobId });
  }

  @Post('reviews/:jobId/cancel')
  cancelReview(@Param('jobId') jobId: string) {
    return sendTo(this.clients.ai, AI_PATTERNS.REVIEW_CANCEL, { jobId });
  }

  @Get('repos/:repoId/reviews')
  listReviews(@Param('repoId') repoId: string): Promise<ReviewJob[]> {
    return sendTo(this.clients.review, REVIEW_PATTERNS.JOBS_LIST, { repoId });
  }

  @Get('repos/:repoId/highlights')
  listHighlights(
    @Param('repoId') repoId: string,
    @Query('pageSlug') pageSlug?: string,
  ): Promise<Highlight[]> {
    return sendTo(this.clients.review, REVIEW_PATTERNS.HIGHLIGHTS_LIST, {
      repoId,
      pageSlug,
    });
  }

  @Get('highlights/:id')
  async getHighlight(@Param('id') id: string): Promise<Highlight> {
    const highlight = await sendTo<Highlight | null>(
      this.clients.review,
      REVIEW_PATTERNS.HIGHLIGHTS_GET,
      { id },
    );
    if (!highlight) {
      throw new NotFoundException(`Highlight ${id} was not found.`);
    }
    return highlight;
  }

  @Patch('highlights/:id')
  updateHighlight(
    @Param('id') id: string,
    @Body() body: { status: HighlightStatus },
  ): Promise<Highlight | undefined> {
    if (!body?.status) {
      throw new BadRequestException('status is required.');
    }
    return sendTo(this.clients.review, REVIEW_PATTERNS.HIGHLIGHTS_UPDATE, {
      id,
      patch: { status: body.status },
    });
  }

  @Post('highlights/:id/fix-wiki')
  async fixWiki(
    @Param('id') id: string,
    @Body() body: { model?: string },
  ) {
    const highlight = await this.requireHighlight(id);
    const model = body?.model ?? (await this.selectedModel());
    if (!model) {
      throw new BadRequestException('Connect an AI provider first.');
    }
    return sendTo(this.clients.ai, AI_PATTERNS.WIKI_REWRITE, {
      repoId: highlight.repoId,
      pageSlug: highlight.pageSlug,
      highlightId: highlight.id,
      model,
    });
  }

  @Post('highlights/:id/plan-code')
  async planCode(
    @Param('id') id: string,
    @Body() body: { model?: string },
  ): Promise<DevPlan> {
    const highlight = await this.requireHighlight(id);
    const model = body?.model ?? (await this.selectedModel());
    if (!model) {
      throw new BadRequestException('Connect an AI provider first.');
    }
    return sendTo(this.clients.ai, AI_PATTERNS.DEV_PLAN, {
      repoId: highlight.repoId,
      highlightId: highlight.id,
      model,
    });
  }

  @Post('highlights/:id/fix-code')
  async fixCode(
    @Param('id') id: string,
    @Body() body: { model?: string; dryRun?: boolean; merge?: boolean },
  ): Promise<DevCycleJob> {
    const highlight = await this.requireHighlight(id);
    const model = body?.model ?? (await this.selectedModel());
    if (!model) {
      throw new BadRequestException('Connect an AI provider first.');
    }
    const plan = await sendTo<DevPlan>(this.clients.ai, AI_PATTERNS.DEV_PLAN, {
      repoId: highlight.repoId,
      highlightId: highlight.id,
      model,
    });
    return sendTo<DevCycleJob>(
      this.clients.github,
      GITHUB_PATTERNS.DEVCYCLE_EXECUTE,
      {
        repoId: highlight.repoId,
        highlightId: highlight.id,
        plan,
        dryRun: body?.dryRun ?? false,
        merge: body?.merge ?? true,
      },
      60 * 60_000,
    );
  }

  @Get('dev-jobs/:jobId')
  getDevJob(@Param('jobId') jobId: string): Promise<DevCycleJob | undefined> {
    return sendTo(this.clients.github, GITHUB_PATTERNS.DEVCYCLE_GET, { jobId });
  }

  @Get('repos/:repoId/dev-jobs')
  listDevJobs(@Param('repoId') repoId: string): Promise<DevCycleJob[]> {
    return sendTo(this.clients.github, GITHUB_PATTERNS.DEVCYCLE_LIST, {
      repoId,
    });
  }

  @Sse('events')
  events(@Query('repoId') repoId?: string): Observable<MessageEvent> {
    return interval(2500).pipe(
      concatMap(() =>
        from(repoId ? this.digest(repoId) : Promise.resolve({})).pipe(
          map((data) => ({ data }) as MessageEvent),
        ),
      ),
    );
  }

  private async digest(repoId: string): Promise<Record<string, unknown>> {
    const [reviews, highlights, sync, devJobs] = await Promise.allSettled([
      sendTo<ReviewJob[]>(this.clients.review, REVIEW_PATTERNS.JOBS_LIST, {
        repoId,
      }),
      sendTo<{ version: number; open: number; total: number }>(
        this.clients.review,
        REVIEW_PATTERNS.STATE_VERSION,
        { repoId },
      ),
      sendTo<SyncState>(this.clients.sync, SYNC_PATTERNS.STATE, { repoId }),
      sendTo<DevCycleJob[]>(this.clients.github, GITHUB_PATTERNS.DEVCYCLE_LIST, {
        repoId,
      }),
    ]);

    const job = reviews.status === 'fulfilled' ? reviews.value[0] : undefined;
    return {
      at: new Date().toISOString(),
      review: job
        ? {
            id: job.id,
            status: job.status,
            stage: job.stage,
            progress: job.progress,
            total: job.total,
            highlightCount: job.highlightCount,
            error: job.error,
          }
        : undefined,
      highlights: highlights.status === 'fulfilled' ? highlights.value : undefined,
      sync: sync.status === 'fulfilled' ? sync.value : undefined,
      devJobs:
        devJobs.status === 'fulfilled'
          ? devJobs.value.slice(0, 5).map((item) => ({
              id: item.id,
              status: item.status,
              stage: item.stage,
              prUrl: item.prUrl,
              error: item.error,
            }))
          : undefined,
    };
  }

  private async requireHighlight(id: string): Promise<Highlight> {
    const highlight = await sendTo<Highlight | undefined>(
      this.clients.review,
      REVIEW_PATTERNS.HIGHLIGHTS_GET,
      { id },
    );
    if (!highlight) {
      throw new NotFoundException(`Highlight ${id} no longer exists.`);
    }
    return highlight;
  }

  private async selectedModel(): Promise<string | undefined> {
    const result = await sendTo<{ selectedModel?: string; models: ModelInfo[] }>(
      this.clients.ai,
      AI_PATTERNS.MODELS_LIST,
      {},
    );
    return result.selectedModel;
  }
}
