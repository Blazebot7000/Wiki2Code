import { Injectable, Logger } from '@nestjs/common';
import {
  DEFAULT_PORTS,
  GITHUB_PATTERNS,
  REVIEW_PATTERNS,
  type DevPlan,
  type FileEdit,
  type Highlight,
  type WikiPage,
  type WikiUpdateResult,
} from '@org/contracts';
import {
  createTcpClient,
  extractJson,
  parseBlocks,
  searchTerms,
  sendTo,
  splitLines,
  truncate,
  type MdBlock,
} from '@org/server';
import { AiService } from './ai.service';

export interface WikiRewriteRequest {
  repoId: string;
  pageSlug: string;
  highlightId: string;
  model: string;
}

export interface WikiRewriteResult extends WikiUpdateResult {
  highlightId: string;
  updatedBlock: string;
}

export interface DevPlanRequest {
  repoId: string;
  highlightId: string;
  model: string;
  dryRun?: boolean;
}

const REWRITE_SYSTEM = `You update wiki documentation so it matches the implementation.

Rules:
- Rewrite only the single markdown block you are given.
- Keep the block's markdown shape: same heading level, same list markers, same code fence language, same table columns.
- State what the code actually does. Do not invent behaviour, options, files, or endpoints.
- Do not add commentary, apologies, or "updated" notes.
- Return the replacement markdown block only. No fences around the whole answer unless the block itself is a code block.`;

const PLAN_SYSTEM = `You are a senior engineer planning a change so that source code matches its wiki documentation.

Rules:
- Produce the smallest correct change. Prefer editing existing files over adding new ones.
- "edits" entries need the full new file content in "content" for every file you change. Never send partial snippets.
- Only touch files that exist in the provided file tree, unless a genuinely new file is required.
- "commands" must be plain package-manager or test-runner invocations, for example "npm install", "npm run build", "npm test". No shell operators, pipes, redirects, or environment assignments.
- "branchName" is a short kebab-case slug without a prefix.
- Respond with JSON only.`;

const ALLOWED_COMMAND =
  /^(npm|npx|pnpm|yarn|node|python|python3|py|pytest|uv|cargo|go|dotnet|mvn|gradle|make|bash|sh)\b/i;
const FORBIDDEN_SHELL = /[;&|><`$]/;
const MAX_PLAN_FILE_CHARS = 24_000;

@Injectable()
export class RewriteService {
  private readonly logger = new Logger(RewriteService.name);
  private readonly github = createTcpClient(
    Number(process.env.GITHUB_SVC_PORT ?? DEFAULT_PORTS.github),
  );
  private readonly reviews = createTcpClient(
    Number(process.env.REVIEW_SVC_PORT ?? DEFAULT_PORTS.review),
  );

  constructor(private readonly ai: AiService) {}

  async rewriteBlock(request: WikiRewriteRequest): Promise<WikiRewriteResult> {
    const highlight = await this.requireHighlight(request.highlightId);
    const page = await sendTo<WikiPage>(this.github, GITHUB_PATTERNS.WIKI_GET, {
      repoId: request.repoId,
      slug: request.pageSlug,
    });

    const blocks = parseBlocks(page.markdown);
    const block =
      blocks.find((item) => item.id === highlight.blockId) ??
      blocks.find(
        (item) =>
          item.lineStart === highlight.lineStart &&
          item.lineEnd === highlight.lineEnd,
      );

    if (!block) {
      throw new Error(
        'The highlighted block no longer exists in the wiki. Re-run the review.',
      );
    }

    const context = await this.contextFor(request.repoId, block.text);
    const replacement = await this.ai.chatWithModel(
      request.model,
      [
        { role: 'system', content: REWRITE_SYSTEM },
        {
          role: 'user',
          content: [
            `WIKI PAGE: ${page.title} (${page.slug})`,
            '',
            'CURRENT BLOCK:',
            '```markdown',
            block.text,
            '```',
            '',
            'REVIEWER EXPLANATION OF THE MISMATCH:',
            highlight.explanation,
            '',
            highlight.wikiSuggestion
              ? `REVIEWER DRAFT (improve on this if the code says otherwise):\n${highlight.wikiSuggestion}\n`
              : '',
            'SOURCE CODE EXCERPTS:',
            context || '(no matching code found)',
            '',
            'Return the replacement markdown block only.',
          ]
            .filter(Boolean)
            .join('\n'),
        },
      ],
      { maxTokens: 2500, temperature: 0.1 },
    );

    const updatedBlock = this.stripWrapper(replacement).trim();
    if (!updatedBlock) {
      throw new Error('The model returned an empty rewrite.');
    }

    const markdown = this.replaceBlock(page.markdown, block, updatedBlock);
    const result = await sendTo<WikiUpdateResult>(
      this.github,
      GITHUB_PATTERNS.WIKI_UPDATE,
      {
        repoId: request.repoId,
        pageSlug: request.pageSlug,
        markdown,
        message: `docs: align "${truncate(page.title, 60)}" with the implementation`,
      },
    );

    await sendTo(this.reviews, REVIEW_PATTERNS.HIGHLIGHTS_UPDATE, {
      id: request.highlightId,
      patch: {
        status: 'resolved',
        wikiSuggestion: updatedBlock,
        explanation: `${highlight.explanation}\n\nWiki updated in ${result.commitSha.slice(0, 7)}.`,
      },
    });

    return {
      ...result,
      highlightId: request.highlightId,
      updatedBlock,
    };
  }

  async planCodeFix(request: DevPlanRequest): Promise<DevPlan> {
    const highlight = await this.requireHighlight(request.highlightId);
    const page = await sendTo<WikiPage>(this.github, GITHUB_PATTERNS.WIKI_GET, {
      repoId: request.repoId,
      slug: highlight.pageSlug,
    });

    const tree = await sendTo<string[]>(
      this.github,
      GITHUB_PATTERNS.CODE_TREE,
      { repoId: request.repoId },
    );
    const treeSet = new Set(tree);

    const context = await this.contextFor(
      request.repoId,
      `${highlight.quote}\n${highlight.codeRefs.map((ref) => ref.path).join('\n')}`,
      highlight.codeRefs.map((ref) => ref.path),
    );

    const raw = await this.ai.chatWithModel(
      request.model,
      [
        { role: 'system', content: PLAN_SYSTEM },
        {
          role: 'user',
          content: [
            `WIKI PAGE: ${page.title} (${page.slug})`,
            '',
            'DOCUMENTED BEHAVIOUR (the wiki block that must become true):',
            '```markdown',
            highlight.quote || this.blockText(page, highlight),
            '```',
            '',
            'REVIEWER FINDING:',
            highlight.explanation,
            '',
            highlight.codePlan ? `REVIEWER SKETCH:\n${highlight.codePlan}\n` : '',
            'REPOSITORY FILES:',
            tree.slice(0, 400).join('\n'),
            '',
            'RELEVANT SOURCE:',
            context || '(no matching code found)',
            '',
            'Return JSON: {"summary":"...","branchName":"...","commitMessage":"...","edits":[{"path":"...","content":"<full file>"}],"commands":{"install":"npm install","build":"npm run build","test":"npm test"},"rationale":"..."}',
          ]
            .filter(Boolean)
            .join('\n'),
        },
      ],
      { json: true, maxTokens: 8000, temperature: 0.1 },
    );

    const parsed = extractJson<DevPlan>(raw);
    if (!parsed || !Array.isArray(parsed.edits) || parsed.edits.length === 0) {
      throw new Error(
        'The model did not produce an actionable plan. Try a different model.',
      );
    }

    const plan = this.sanitizePlan(parsed, treeSet);
    if (plan.edits.length === 0) {
      throw new Error('Every proposed edit was rejected by the path guard.');
    }

    await sendTo(this.reviews, REVIEW_PATTERNS.HIGHLIGHTS_UPDATE, {
      id: request.highlightId,
      patch: { codePlan: plan.rationale || plan.summary },
    });

    return plan;
  }

  private async requireHighlight(id: string): Promise<Highlight> {
    const highlight = await sendTo<Highlight | undefined>(
      this.reviews,
      REVIEW_PATTERNS.HIGHLIGHTS_GET,
      { id },
    );
    if (!highlight) {
      throw new Error(`Highlight ${id} no longer exists.`);
    }
    return highlight;
  }

  private blockText(page: WikiPage, highlight: Highlight): string {
    const blocks = parseBlocks(page.markdown);
    const block =
      blocks.find((item) => item.id === highlight.blockId) ??
      blocks.find(
        (item) =>
          item.lineStart === highlight.lineStart &&
          item.lineEnd === highlight.lineEnd,
      );
    return block?.text ?? '';
  }

  private async contextFor(
    repoId: string,
    seedText: string,
    preferredPaths: string[] = [],
  ): Promise<string> {
    const paths = new Set<string>();
    for (const path of preferredPaths.slice(0, 6)) {
      paths.add(path);
    }

    if (paths.size < 6) {
      const terms = searchTerms(seedText, 10);
      if (terms.length) {
        try {
          const hits = await sendTo<
            { path: string; line: number; text: string }[]
          >(this.github, GITHUB_PATTERNS.CODE_SEARCH, {
            repoId,
            terms,
            maxFiles: 10,
          });
          for (const hit of hits) {
            if (paths.size >= 6) {
              break;
            }
            paths.add(hit.path);
          }
        } catch {
          // search failures should not abort the operation
        }
      }
    }

    const parts: string[] = [];
    let budget = 30_000;
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
        const excerpt = truncate(
          file.content,
          Math.min(MAX_PLAN_FILE_CHARS, budget),
        );
        budget -= excerpt.length;
        parts.push(`--- ${path} ---\n${excerpt}`);
      } catch {
        // skip unreadable files
      }
    }
    return parts.join('\n\n');
  }

  private replaceBlock(
    markdown: string,
    block: MdBlock,
    replacement: string,
  ): string {
    const lines = splitLines(markdown);
    const next = replacement.replace(/\r\n/g, '\n').split('\n');
    lines.splice(block.lineStart - 1, block.lineEnd - block.lineStart + 1, ...next);
    return lines.join('\n');
  }

  private stripWrapper(text: string): string {
    const trimmed = text.trim();
    const match = /^```(?:markdown|md)?\r?\n([\s\S]*?)\r?\n```$/.exec(trimmed);
    return match ? match[1] : trimmed;
  }

  private sanitizePlan(plan: DevPlan, tree: Set<string>): DevPlan {
    const edits: FileEdit[] = [];
    for (const edit of plan.edits) {
      const path = String(edit?.path ?? '').replace(/\\/g, '/').trim();
      if (!this.isSafePath(path)) {
        this.logger.warn(`Dropping edit with unsafe path: ${path}`);
        continue;
      }
      if (!tree.has(path) && !edit.content) {
        this.logger.warn(`Dropping delete of unknown file: ${path}`);
        continue;
      }
      if (edit.delete) {
        if (tree.has(path)) {
          edits.push({ path, delete: true });
        }
        continue;
      }
      if (typeof edit.content !== 'string' || edit.content.length === 0) {
        continue;
      }
      edits.push({ path, content: edit.content });
    }

    const commands: DevPlan['commands'] = {};
    for (const key of ['install', 'build', 'test'] as const) {
      const value = plan.commands?.[key];
      if (!value) {
        continue;
      }
      const command = String(value).trim();
      if (!ALLOWED_COMMAND.test(command) || FORBIDDEN_SHELL.test(command)) {
        this.logger.warn(`Dropping disallowed ${key} command: ${command}`);
        continue;
      }
      commands[key] = command;
    }

    return {
      summary: truncate(String(plan.summary ?? 'Align code with documentation'), 160),
      branchName: String(plan.branchName ?? 'align-code-with-docs'),
      commitMessage: truncate(
        String(plan.commitMessage ?? plan.summary ?? 'Align code with documentation'),
        200,
      ),
      edits,
      commands,
      rationale: String(plan.rationale ?? ''),
    };
  }

  private isSafePath(path: string): boolean {
    if (!path || path.length > 400) {
      return false;
    }
    if (path.startsWith('/') || path.includes('..') || /^[a-z]:/i.test(path)) {
      return false;
    }
    if (path.split('/').some((part) => part.length === 0)) {
      return false;
    }
    return /^[a-zA-Z0-9._@\-/]+$/.test(path);
  }
}
