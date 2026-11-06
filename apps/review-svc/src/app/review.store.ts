import type { Highlight, ReviewJob } from '@org/contracts';
import { dataPath, JsonStore } from '@org/server';

export interface ReviewState {
  highlights: Highlight[];
  jobs: ReviewJob[];
  version: number;
}

export const reviewStore = new JsonStore<ReviewState>(
  dataPath('review-svc.json'),
  { highlights: [], jobs: [], version: 0 },
);
