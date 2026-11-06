export type BlockType =
  | 'heading'
  | 'paragraph'
  | 'code'
  | 'list'
  | 'quote'
  | 'table'
  | 'hr';

export interface MdBlock {
  id: string;
  type: BlockType;
  lineStart: number;
  lineEnd: number;
  text: string;
  headingLevel?: number;
}

export function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^(#{1,6})\s+/;
const LIST_ITEM = /^\s*([-*+]|\d+[.)])\s+/;
const QUOTE = /^\s*>\s?/;
const TABLE = /^\s*\|/;
const HR = /^\s*([-*_])(\s*\1){2,}\s*$/;

function startsBlock(line: string): boolean {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    LIST_ITEM.test(line) ||
    QUOTE.test(line) ||
    TABLE.test(line) ||
    HR.test(line)
  );
}

export function splitLines(markdown: string): string[] {
  return markdown.replace(/\r\n/g, '\n').split('\n');
}

export function parseBlocks(markdown: string): MdBlock[] {
  const lines = splitLines(markdown);
  const blocks: MdBlock[] = [];
  let index = 0;

  const push = (
    type: BlockType,
    start: number,
    end: number,
    headingLevel?: number,
  ) => {
    const text = lines.slice(start, end + 1).join('\n');
    blocks.push({
      id: `${start + 1}:${hashText(text)}`,
      type,
      lineStart: start + 1,
      lineEnd: end + 1,
      text,
      headingLevel,
    });
  };

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1];
      let end = index + 1;
      while (end < lines.length && !lines[end].trim().startsWith(marker)) {
        end += 1;
      }
      const last = Math.min(end, lines.length - 1);
      push('code', index, last);
      index = last + 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      push('heading', index, index, heading[1].length);
      index += 1;
      continue;
    }

    if (HR.test(line)) {
      push('hr', index, index);
      index += 1;
      continue;
    }

    if (TABLE.test(line)) {
      let end = index;
      while (end + 1 < lines.length && TABLE.test(lines[end + 1])) {
        end += 1;
      }
      push('table', index, end);
      index = end + 1;
      continue;
    }

    if (QUOTE.test(line)) {
      let end = index;
      while (end + 1 < lines.length && QUOTE.test(lines[end + 1])) {
        end += 1;
      }
      push('quote', index, end);
      index = end + 1;
      continue;
    }

    if (LIST_ITEM.test(line)) {
      let end = index;
      while (
        end + 1 < lines.length &&
        lines[end + 1].trim() &&
        (LIST_ITEM.test(lines[end + 1]) ||
          /^\s{2,}\S/.test(lines[end + 1]))
      ) {
        end += 1;
      }
      push('list', index, end);
      index = end + 1;
      continue;
    }

    let end = index;
    while (
      end + 1 < lines.length &&
      lines[end + 1].trim() &&
      !startsBlock(lines[end + 1])
    ) {
      end += 1;
    }
    push('paragraph', index, end);
    index = end + 1;
  }

  return blocks;
}

export function blockTitle(block: MdBlock, maxLength = 80): string {
  const text = block.text
    .replace(/^#+\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

export function chunkBlocks(blocks: MdBlock[], maxChars: number): MdBlock[][] {
  const chunks: MdBlock[][] = [];
  let current: MdBlock[] = [];
  let size = 0;
  for (const block of blocks) {
    const blockSize = block.text.length + 40;
    if (current.length > 0 && size + blockSize > maxChars) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(block);
    size += blockSize;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}
