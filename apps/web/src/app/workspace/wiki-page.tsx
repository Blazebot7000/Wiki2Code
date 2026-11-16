import type { Highlight, WikiPage } from '@org/contracts';
import { parseBlocks } from '@org/markdown';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface WikiPageViewProps {
  page: WikiPage;
  highlights: Highlight[];
  busyHighlightId?: string;
  reviewingSelection?: boolean;
  onReviewSelection?: (input: { text: string; blockIds: string[] }) => void;
  onFixWiki: (highlight: Highlight) => void;
  onFixCode: (highlight: Highlight) => void;
  onDismiss: (highlight: Highlight) => void;
}

interface HoverState {
  highlight: Highlight;
  top: number;
  left: number;
}

interface SelectionState {
  x: number;
  y: number;
  text: string;
  blockIds: string[];
}

interface DesktopBridge {
  suppressNextContextMenu?: () => void;
}

type DesktopWindow = Window & { wiki2code?: DesktopBridge };

const SEVERITY_LABEL: Record<Highlight['severity'], string> = {
  info: 'Note',
  warning: 'Warning',
  error: 'Mismatch',
};

export function WikiPageView({
  page,
  highlights,
  busyHighlightId,
  reviewingSelection,
  onReviewSelection,
  onFixWiki,
  onFixCode,
  onDismiss,
}: WikiPageViewProps) {
  const blocks = useMemo(() => parseBlocks(page.markdown), [page.markdown]);
  const [hover, setHover] = useState<HoverState>();
  const [selectionMenu, setSelectionMenu] = useState<SelectionState>();
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const bodyRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  const byBlock = useMemo(() => {
    const map = new Map<string, Highlight>();
    for (const highlight of highlights) {
      if (highlight.status === 'resolved' || highlight.status === 'dismissed') {
        continue;
      }
      map.set(highlight.blockId, highlight);
    }
    return map;
  }, [highlights]);

  useEffect(() => {
    const onScroll = () => {
      setHover(undefined);
      setSelectionMenu(undefined);
    };
    window.addEventListener('scroll', onScroll, true);
    return () => window.removeEventListener('scroll', onScroll, true);
  }, []);

  useEffect(() => {
    setSelectionMenu(undefined);
  }, [page.slug]);

  useEffect(() => {
    if (!selectionMenu) {
      return;
    }
    menuButtonRef.current?.focus({ preventScroll: true });
    const close = () => setSelectionMenu(undefined);
    const onPointerDown = (event: MouseEvent) => {
      if (menuRef.current?.contains(event.target as Node)) {
        return;
      }
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        close();
      }
    };
    document.addEventListener('mousedown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', close);
    };
  }, [selectionMenu]);

  useEffect(() => {
    return () => {
      if (hideTimer.current) {
        clearTimeout(hideTimer.current);
      }
    };
  }, []);

  const openSelectionMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    const selection = window.getSelection();
    const text = selection?.toString().trim() ?? '';
    const body = bodyRef.current;
    if (!selection || selection.isCollapsed || !text || !body) {
      return;
    }
    if (selection.rangeCount === 0) {
      return;
    }
    const range = selection.getRangeAt(0);
    if (!range.intersectsNode(body)) {
      return;
    }
    const blockIds: string[] = [];
    body.querySelectorAll<HTMLElement>('.md-block').forEach((element) => {
      if (!range.intersectsNode(element)) {
        return;
      }
      const id = element.dataset.blockId;
      if (id) {
        blockIds.push(id);
      }
    });
    if (!blockIds.length) {
      return;
    }
    event.preventDefault();
    // The Electron shell shows a native menu for text selections; suppress it
    // so only this review menu appears.
    (window as DesktopWindow).wiki2code?.suppressNextContextMenu?.();
    setSelectionMenu({
      x: Math.min(event.clientX, Math.max(12, window.innerWidth - 280)),
      y: Math.min(event.clientY, Math.max(12, window.innerHeight - 150)),
      text,
      blockIds,
    });
  };

  const scheduleHide = () => {
    if (hideTimer.current) {
      clearTimeout(hideTimer.current);
    }
    hideTimer.current = setTimeout(() => setHover(undefined), 220);
  };

  const cancelHide = () => {
    if (hideTimer.current) {
      clearTimeout(hideTimer.current);
    }
  };

  const show = (highlight: Highlight, element: HTMLElement) => {
    cancelHide();
    const rect = element.getBoundingClientRect();
    const width = 400;
    const height = 340;
    const left = Math.min(
      Math.max(12, rect.left),
      Math.max(12, window.innerWidth - width - 16),
    );
    const below = rect.bottom + 10;
    const top =
      below + height > window.innerHeight
        ? Math.max(12, rect.top - height - 10)
        : below;
    setHover({ highlight, top, left });
  };

  return (
    <article className="wiki">
      <header className="wiki__head">
        <h1>{page.title}</h1>
        <span className="wiki__slug">{page.path}</span>
      </header>

      <div
        className="wiki__body"
        ref={bodyRef}
        onContextMenu={openSelectionMenu}
      >
        {blocks.map((block) => {
          const highlight = byBlock.get(block.id);
          const classes = ['md-block'];
          if (highlight) {
            classes.push(
              'md-block--flagged',
              `md-block--${highlight.severity}`,
            );
            if (highlight.status === 'stale') {
              classes.push('md-block--stale');
            }
          }
          return (
            <div
              key={block.id}
              className={classes.join(' ')}
              data-block-id={block.id}
              onMouseEnter={(event) => {
                if (highlight) {
                  show(highlight, event.currentTarget);
                }
              }}
              onMouseLeave={scheduleHide}
            >
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {block.text}
              </ReactMarkdown>
              {highlight ? (
                <span className={`md-flag md-flag--${highlight.severity}`}>
                  {SEVERITY_LABEL[highlight.severity]}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>

      {hover ? (
        <div
          className="hover-card"
          style={{ top: hover.top, left: hover.left }}
          onMouseEnter={cancelHide}
          onMouseLeave={scheduleHide}
          role="dialog"
          aria-label="Wiki and code mismatch details"
        >
          <div className="hover-card__head">
            <span className={`pill pill--${hover.highlight.severity}`}>
              {SEVERITY_LABEL[hover.highlight.severity]}
            </span>
            <strong>{hover.highlight.title}</strong>
            <button
              type="button"
              className="hover-card__close"
              onClick={() => setHover(undefined)}
              aria-label="Close"
            >
              ×
            </button>
          </div>

          <div className="hover-card__body">
            <p className="hover-card__explanation">
              {hover.highlight.explanation}
            </p>

            {hover.highlight.codeRefs.length > 0 ? (
              <div className="hover-card__refs">
                <span className="hover-card__label">Code</span>
                <ul>
                  {hover.highlight.codeRefs.map((ref) => (
                    <li key={`${ref.path}:${ref.startLine ?? 0}`}>
                      <code>{ref.path}</code>
                      {ref.startLine
                        ? `:${ref.startLine}${
                            ref.endLine ? `-${ref.endLine}` : ''
                          }`
                        : ''}
                      {ref.note ? <em> — {ref.note}</em> : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {hover.highlight.status === 'stale' ? (
              <p className="hover-card__stale">
                The code changed since this was found. Re-run the review to
                refresh it.
              </p>
            ) : null}
          </div>

          <div className="hover-card__actions">
            <button
              type="button"
              className="btn btn--ai btn--small"
              disabled={busyHighlightId === hover.highlight.id}
              onClick={() => onFixWiki(hover.highlight)}
              title="Runs AI and may incur provider costs"
            >
              <span className="btn__star" aria-hidden="true">
                ★
              </span>
              {busyHighlightId === hover.highlight.id
                ? 'Updating…'
                : 'Update wiki to match code'}
            </button>
            <button
              type="button"
              className="btn btn--ai btn--small"
              disabled={busyHighlightId === hover.highlight.id}
              onClick={() => onFixCode(hover.highlight)}
              title="Runs AI and may incur provider costs"
            >
              <span className="btn__star" aria-hidden="true">
                ★
              </span>
              Fix code to match wiki
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--small"
              onClick={() => onDismiss(hover.highlight)}
            >
              Dismiss
            </button>
          </div>
        </div>
      ) : null}

      {selectionMenu ? (
        <div
          className="context-menu"
          ref={menuRef}
          style={{ top: selectionMenu.y, left: selectionMenu.x }}
          role="menu"
          aria-label="Selected wiki text actions"
        >
          <button
            type="button"
            ref={menuButtonRef}
            className="context-menu__item"
            role="menuitem"
            disabled={reviewingSelection}
            onClick={() => {
              const current = selectionMenu;
              setSelectionMenu(undefined);
              onReviewSelection?.({
                text: current.text,
                blockIds: current.blockIds,
              });
            }}
            title="Runs AI and may incur provider costs"
          >
            <span className="btn__star" aria-hidden="true">
              ★
            </span>
            <span>
              {reviewingSelection ? 'Reviewing…' : 'Review selection'}
            </span>
            <span className="context-menu__hint">AI</span>
          </button>
          <p className="context-menu__note" role="presentation">
            Checks only the selected text against the code.
          </p>
        </div>
      ) : null}
    </article>
  );
}
