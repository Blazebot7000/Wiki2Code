import { Injectable, Logger } from '@nestjs/common';
import {
  DEFAULT_PORTS,
  GITHUB_PATTERNS,
  REVIEW_PATTERNS,
  type CodeReference,
  type ConnectedRepo,
  type Highlight,
  type HighlightSeverity,
  type ReviewJob,
  type ReviewRequest,
  type WikiPage,
  type WikiPageMeta,
} from '@org/contracts';
import {
  blockTitle,
  chunkBlocks,
  createTcpClient,
  extractJson,
  newId,
  parseBlocks,
  searchTerms,
  sendTo,
  truncate,
  type MdBlock,
} from '@org/server';
import { AiService } from './ai.service';

interface Finding {
  blockId: string;
  severity: HighlightSeverity;
  title: string;
  explanation: string;
  codeRefs: CodeReference[];
  wikiSuggestion: string;
  codePlan: string;
}

interface BatchResult {
  findings: Finding[];
}

const MAX_BATCH_BLOCKS = 5;
const MAX_BATCH_CHARS = 4200;

const SYSTEM_PROMPT = `You are Wiki2Code's documentation auditor. You compare a project's wiki documentation with its actual source code and report only real contradictions.

Rules:
- Report a finding only when the code contradicts the documentation, or the documentation describes behaviour that does not exist, or the documented API/flow differs materially from the implementation.
- Never report missing documentation, style issues, typos, or speculation. If a block is consistent or cannot be verified from the excerpts, return no finding for it.
- Cite only files and line numbers present in the provided code excerpts. Never invent paths.
- "explanation" must state what the code actually does and how that differs from the wiki text.
- "wikiSuggestion" must be replacement markdown for that block that makes it accurate, preserving the original formatting style.
- "codePlan" must be a short, concrete implementation plan that would change the code to match the documentation.
- Respond with JSON only, matching the requested schema.`;

@Injectable()
export class ReviewEngineService {
  private readonly logger = new Logger(ReviewEngineService.name);
  private readonly cancelled = new Set<string>();
  private readonly github = createTcpClient(
    Number(process.env.GITHUB_SVC_PORT ?? DEFAULT_PORTS.github),
  );
  private readonly reviews = createTcpClient(
    Number(process.env.REVIEW_SVC_PORT ?? DEFAULT_PORTS.review),
  );

  constructor(private readonly ai: AiService) {}

  async start(payload: ReviewRequest): Promise<ReviewJob> {
    const model = payload.model || this.ai.selectedModel();
    if (!model) {
      throw new Error('Connect an AI provider before reviewing.');
    }
    const job: ReviewJob = {
      id: newId('rev'),
      repoId: payload.repoId,
      model,
      status: 'queued',
      stage: 'Queued',
      progress: 0,
      total: 0,
      highlightCount: 0,
      startedAt: new Date().toISOString(),
    };
    await sendTo(this.reviews, REVIEW_PATTERNS.JOBS_CREATE, job);
    void this.run(job, { ...payload, model })
      .catch((error) => {
        if (this.cancelled.has(job.id)) {
          return;
        }
        this.logger.error(`Review ${job.id} failed: ${String(error)}`);
        void this.finish(job.id, {
          status: 'failed',
          stage: 'Review failed',
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.cancelled.delete(job.id);
      });
    return job;
  }

  get(jobId: string): Promise<ReviewJob | undefined> {
    return sendTo<ReviewJob | undefined>(
      this.reviews,
      REVIEW_PATTERNS.JOBS_GET,
      { id: jobId },
    );
  }

  async cancel(jobId: string): Promise<{ ok: true }> {
    const current = await this.get(jobId);
    if (
      current &&
      (current.status === 'completed' ||
        current.status === 'failed' ||
        current.status === 'cancelled')
    ) {
      return { ok: true };
    }
    this.cancelled.add(jobId);
    await this.finish(jobId, { status: 'cancelled', stage: 'Cancelled' });
    return { ok: true };
  }

  private async run(job: ReviewJob, payload: ReviewRequest): Promise<void> {
    await this.review(job, payload);
  }

  private async review(job: ReviewJob, payload: ReviewRequest): Promise<void> {
    await this.update(job.id, { status: 'running', stage: 'Loading wiki' });

    const pages = await sendTo<WikiPageMeta[]>(
      this.github,
      GITHUB_PATTERNS.WIKI_LIST,
      { repoId: payload.repoId },
    );
    if (!pages.length) {
      throw new Error(
        'This repository has no wiki pages yet. Create a page on GitHub, then sync.',
      );
    }

    const repo = await sendTo<ConnectedRepo>(
      this.github,
      GITHUB_PATTERNS.REPO_GET,
      { repoId: payload.repoId },
    );
    const codeTree = new Set(
      await sendTo<string[]>(this.github, GITHUB_PATTERNS.CODE_TREE, {
        repoId: payload.repoId,
      }),
    );

    const pagePlans: { meta: WikiPageMeta; blocks: MdBlock[] }[] = [];

    for (const meta of pages) {
      const page = await sendTo<WikiPage>(
        this.github,
        GITHUB_PATTERNS.WIKI_GET,
        { repoId: payload.repoId, slug: meta.slug },
      );
      let blocks = parseBlocks(page.markdown).filter(
        (block) => block.type !== 'hr' && block.text.trim().length > 0,
      );
      if (payload.incremental && payload.changedPaths?.length) {
        const changed = payload.changedPaths.map((path) =>
          path.toLowerCase().replace(/\\/g, '/'),
        );
        blocks = blocks.filter((block) => {
          const terms = searchTerms(block.text, 10).map((term) =>
            term.toLowerCase(),
          );
          return terms.some((term) =>
            changed.some((path) => path.includes(term) || term.includes(path)),
          );
        });
      }
      if (blocks.length) {
        pagePlans.push({ meta, blocks });
      }
    }

    if (this.cancelled.has(job.id)) {
      return;
    }

    if (!pagePlans.length) {
      await this.finish(job.id, {
        status: 'completed',
        stage: 'Nothing to review',
        highlightCount: 0,
      });
      return;
    }

    const batches: { meta: WikiPageMeta; blocks: MdBlock[] }[] = [];
    for (const plan of pagePlans) {
      for (const group of chunkBlocks(plan.blocks, MAX_BATCH_CHARS)) {
        for (let index = 0; index < group.length; index += MAX_BATCH_BLOCKS) {
          batches.push({
            meta: plan.meta,
            blocks: group.slice(index, index + MAX_BATCH_BLOCKS),
          });
        }
      }
    }

    await this.update(job.id, { total: batches.length, stage: 'Reviewing wiki' });

    const collected = new Map<string, Highlight[]>();
    const failedPages = new Set<string>();
    let failures = 0;
    let lastError: string | undefined;
    let highlightCount = 0;

    for (let index = 0; index < batches.length; index += 1) {
      if (this.cancelled.has(job.id)) {
        return;
      }
      const batch = batches[index];
      await this.update(job.id, {
        progress: index,
        stage: `Reviewing ${batch.meta.title} (${index + 1}/${batches.length})`,
      });

      try {
        const findings = await this.reviewBatch(
          payload.repoId,
          batch.meta,
          batch.blocks,
          payload.model,
          codeTree,
        );
        const existing = collected.get(batch.meta.slug) ?? [];
        collected.set(
          batch.meta.slug,
          existing.concat(
            findings.map((finding) =>
              this.toHighlight({
                finding,
                repoId: payload.repoId,
                page: batch.meta,
                block: batch.blocks.find(
                  (block) => block.id === finding.blockId,
                ),
                model: payload.model,
                commitSha: repo.lastWikiSha ?? '',
              }),
            ),
          ),
        );
        highlightCount += findings.length;
      } catch (error) {
        failures += 1;
        failedPages.add(batch.meta.slug);
        lastError = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `Batch ${index + 1}/${batches.length} failed: ${lastError}`,
        );
      }

      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    if (this.cancelled.has(job.id)) {
      return;
    }

    // Keep the previous highlights for pages whose batch failed: replacing them
    // with an empty list would silently erase real findings.
    for (const plan of pagePlans) {
      if (this.cancelled.has(job.id)) {
        return;
      }
      if (failedPages.has(plan.meta.slug)) {
        continue;
      }
      const highlights = (collected.get(plan.meta.slug) ?? []).filter(
        (item) => item.lineStart > 0,
      );
      await sendTo(this.reviews, REVIEW_PATTERNS.HIGHLIGHTS_REPLACE_PAGE, {
        repoId: payload.repoId,
        pageSlug: plan.meta.slug,
        highlights: highlights.map(({ id: _id, createdAt: _c, updatedAt: _u, ...rest }) => rest),
      });
    }

    if (failures > 0) {
      throw new Error(
        failures === batches.length
          ? `The review could not run: ${lastError ?? 'unknown error'}`
          : `${failures} of ${batches.length} review batches failed: ${lastError ?? 'unknown error'}`,
      );
    }

    if (this.cancelled.has(job.id)) {
      return;
    }

    await this.finish(job.id, {
      status: 'completed',
      stage: 'Review complete',
      highlightCount,
      progress: batches.length,
    });
  }

  private async reviewBatch(
    repoId: string,
    page: WikiPageMeta,
    blocks: MdBlock[],
    model: string,
    codeTree: Set<string>,
  ): Promise<Finding[]> {
    const context = await this.collectContext(repoId, blocks);
    const blockPayload = blocks.map((block) => ({
      id: block.id,
      type: block.type,
      lines: `${block.lineStart}-${block.lineEnd}`,
      text: truncate(block.text, 1200),
    }));

    const user = [
      `PAGE: ${page.title} (${page.slug})`,
      '',
      'WIKI BLOCKS:',
      JSON.stringify(blockPayload, null, 2),
      '',
      'CODE EXCERPTS:',
      context || '(no matching code found)',
      '',
      'Return JSON: {"findings":[{"blockId":"<id from WIKI BLOCKS>","severity":"info|warning|error","title":"...","explanation":"...","codeRefs":[{"path":"...","startLine":1,"endLine":2,"note":"..."}],"wikiSuggestion":"...","codePlan":"..."}]}',
      'Return {"findings":[]} when every block is accurate or cannot be verified.',
    ].join('\n');

    const raw = await this.ai.chatWithModel(
      model,
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: user },
      ],
      { json: true, maxTokens: 4000, temperature: 0.1 },
    );

    const parsed = extractJson<BatchResult>(raw);
    if (!parsed || !Array.isArray(parsed.findings)) {
      return [];
    }

    const ids = new Set(blocks.map((block) => block.id));
    return parsed.findings
      .filter((finding) => ids.has(finding.blockId))
      .map((finding) => ({
        blockId: finding.blockId,
        severity: this.severity(finding.severity),
        title: truncate(String(finding.title ?? 'Wiki/code mismatch'), 120),
        explanation: String(finding.explanation ?? ''),
        wikiSuggestion: String(finding.wikiSuggestion ?? ''),
        codePlan: String(finding.codePlan ?? ''),
        codeRefs: (Array.isArray(finding.codeRefs) ? finding.codeRefs : [])
          .filter((ref) => ref?.path && codeTree.has(ref.path))
          .slice(0, 5)
          .map((ref) => ({
            path: ref.path,
            startLine: Number(ref.startLine) || undefined,
            endLine: Number(ref.endLine) || undefined,
            note: ref.note ? truncate(String(ref.note), 200) : undefined,
          })),
      }))
      .filter((finding) => finding.explanation.length > 0);
  }

  private async collectContext(
    repoId: string,
    blocks: MdBlock[],
  ): Promise<string> {
    const paths = new Set<string>();
    for (const block of blocks) {
      const terms = searchTerms(block.text, 8);
      if (!terms.length) {
        continue;
      }
      try {
        const hits = await sendTo<{ path: string; line: number; text: string }[]>(
          this.github,
          GITHUB_PATTERNS.CODE_SEARCH,
          { repoId, terms, maxFiles: 8 },
        );
        for (const hit of hits) {
          paths.add(hit.path);
          if (paths.size >= 6) {
            break;
          }
        }
      } catch {
        // a failed search should not abort the review
      }
      if (paths.size >= 6) {
        break;
      }
    }

    const parts: string[] = [];
    let budget = 18_000;
    for (const path of paths) {
      if (budget <= 0) {
        break;
      }
      try {
        const file = await sendTo<{ path: string; content: string }>(
          this.github,
          GITHUB_PATTERNS.CODE_READ,
          { repoId, path },
        );
        const lines = file.content.split(/\r?\n/).slice(0, 220);
        const numbered = lines
          .map((line, index) => `${index + 1}: ${line}`)
          .join('\n');
        const excerpt = truncate(numbered, Math.min(6000, budget));
        budget -= excerpt.length;
        parts.push(`--- ${path} ---\n${excerpt}`);
      } catch {
        // skip unreadable files
      }
    }
    return parts.join('\n\n');
  }

  private toHighlight(input: {
    finding: Finding;
    repoId: string;
    page: WikiPageMeta;
    block: MdBlock | undefined;
    model: string;
    commitSha: string;
  }): Highlight {
    const now = new Date().toISOString();
    const block = input.block;
    return {
      id: '',
      repoId: input.repoId,
      pageSlug: input.page.slug,
      pageTitle: input.page.title,
      blockId: input.finding.blockId,
      lineStart: block?.lineStart ?? 0,
      lineEnd: block?.lineEnd ?? 0,
      quote: truncate(block?.text ?? '', 500),
      severity: input.finding.severity,
      status: 'open',
      title: input.finding.title || (block ? blockTitle(block) : 'Wiki/code mismatch'),
      explanation: input.finding.explanation,
      codeRefs: input.finding.codeRefs,
      wikiSuggestion: input.finding.wikiSuggestion,
      codePlan: input.finding.codePlan,
      model: input.model,
      commitSha: input.commitSha,
      createdAt: now,
      updatedAt: now,
    };
  }

  private severity(value: unknown): HighlightSeverity {
    return value === 'error' || value === 'warning' ? value : 'info';
  }

  private update(jobId: string, patch: Partial<ReviewJob>): Promise<unknown> {
    return sendTo(this.reviews, REVIEW_PATTERNS.JOBS_UPDATE, {
      id: jobId,
      patch,
    });
  }

  private finish(
    jobId: string,
    patch: Partial<ReviewJob>,
  ): Promise<unknown> {
    return this.update(jobId, {
      ...patch,
      finishedAt: new Date().toISOString(),
    });
  }
}
