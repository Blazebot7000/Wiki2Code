import { Injectable } from '@nestjs/common';
import type { Highlight, ReviewJob } from '@org/contracts';
import { newId } from '@org/server';
import { reviewStore } from './review.store';

@Injectable()
export class ReviewService {
  listHighlights(repoId: string, pageSlug?: string): Highlight[] {
    return reviewStore
      .read()
      .highlights.filter(
        (item) =>
          item.repoId === repoId &&
          (pageSlug ? item.pageSlug === pageSlug : true),
      )
      .sort((a, b) =>
        a.pageSlug === b.pageSlug
          ? a.lineStart - b.lineStart
          : a.pageSlug.localeCompare(b.pageSlug),
      );
  }

  getHighlight(id: string): Highlight | undefined {
    return reviewStore.read().highlights.find((item) => item.id === id);
  }

  replacePage(input: {
    repoId: string;
    pageSlug: string;
    highlights: Omit<Highlight, 'id' | 'createdAt' | 'updatedAt'>[];
  }): Highlight[] {
    const now = new Date().toISOString();
    const existing = reviewStore.read();
    const kept = existing.highlights.filter(
      (item) =>
        !(
          item.repoId === input.repoId &&
          item.pageSlug === input.pageSlug &&
          (item.status === 'open' || item.status === 'stale')
        ),
    );
    const created: Highlight[] = input.highlights.map((item) => ({
      ...item,
      id: newId('hl'),
      createdAt: now,
      updatedAt: now,
    }));
    reviewStore.write({
      ...existing,
      highlights: [...kept, ...created],
      version: existing.version + 1,
    });
    return created;
  }

  updateHighlight(
    id: string,
    patch: Partial<Pick<Highlight, 'status' | 'explanation' | 'wikiSuggestion' | 'codePlan'>>,
  ): Highlight | undefined {
    const state = reviewStore.read();
    const index = state.highlights.findIndex((item) => item.id === id);
    if (index === -1) {
      return undefined;
    }
    const updated: Highlight = {
      ...state.highlights[index],
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    const highlights = [...state.highlights];
    highlights[index] = updated;
    reviewStore.write({
      ...state,
      highlights,
      version: state.version + 1,
    });
    return updated;
  }

  markStale(input: {
    repoId: string;
    paths: string[];
    commitSha: string;
  }): number {
    const state = reviewStore.read();
    const paths = input.paths.map((path) => path.replace(/\\/g, '/'));
    let changed = 0;
    const highlights = state.highlights.map((item) => {
      if (item.repoId !== input.repoId || item.status !== 'open') {
        return item;
      }
      const touched = item.codeRefs.some((ref) =>
        paths.some(
          (path) =>
            path === ref.path ||
            path.endsWith(`/${ref.path}`) ||
            ref.path.endsWith(`/${path}`),
        ),
      );
      if (!touched) {
        return item;
      }
      changed += 1;
      return {
        ...item,
        status: 'stale' as const,
        updatedAt: new Date().toISOString(),
      };
    });
    if (changed > 0) {
      reviewStore.write({
        ...state,
        highlights,
        version: state.version + 1,
      });
    }
    return changed;
  }

  createJob(job: ReviewJob): ReviewJob {
    const state = reviewStore.read();
    reviewStore.write({
      ...state,
      jobs: [job, ...state.jobs].slice(0, 50),
      version: state.version + 1,
    });
    return job;
  }

  updateJob(id: string, patch: Partial<ReviewJob>): ReviewJob | undefined {
    const state = reviewStore.read();
    const index = state.jobs.findIndex((item) => item.id === id);
    if (index === -1) {
      return undefined;
    }
    const updated = { ...state.jobs[index], ...patch };
    const jobs = [...state.jobs];
    jobs[index] = updated;
    reviewStore.write({
      ...state,
      jobs,
      version: state.version + 1,
    });
    return updated;
  }

  getJob(id: string): ReviewJob | undefined {
    return reviewStore.read().jobs.find((item) => item.id === id);
  }

  listJobs(repoId: string): ReviewJob[] {
    return reviewStore.read().jobs.filter((item) => item.repoId === repoId);
  }

  stateVersion(repoId: string): { version: number; open: number; total: number } {
    const state = reviewStore.read();
    const highlights = state.highlights.filter((item) => item.repoId === repoId);
    return {
      version: state.version,
      open: highlights.filter((item) => item.status === 'open').length,
      total: highlights.length,
    };
  }
}
