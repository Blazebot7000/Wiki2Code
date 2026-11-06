import type { DevCycleJob } from '@org/contracts';

const STAGE_LABEL: Record<string, string> = {
  planning: 'Architect & plan',
  branching: 'Create branch',
  editing: 'Apply edits',
  installing: 'Install dependencies',
  building: 'Build',
  testing: 'Test / verify',
  committing: 'Commit',
  pushing: 'Push',
  'opening-pr': 'Open pull request',
  merging: 'Merge',
  done: 'Done',
  failed: 'Failed',
};

export function DevJobDialog({
  job,
  onClose,
}: {
  job: DevCycleJob;
  onClose: () => void;
}) {
  const running = job.status === 'running';
  return (
    <div className="modal-backdrop" onClick={running ? undefined : onClose}>
      <div
        className="modal job-dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal__head">
          <div>
            <h2>
              {running ? 'Running development cycle' : `Development cycle ${job.status}`}
            </h2>
            <p className="muted">
              Branch <code>{job.branch}</code>
              {job.dryRun ? ' · dry run' : ''}
            </p>
          </div>
          <button
            type="button"
            className="modal__close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </header>

        <ol className="steps-timeline">
          {job.steps.map((step, index) => (
            <li
              key={`${step.stage}-${index}`}
              className={
                step.ok === false
                  ? 'is-failed'
                  : step.ok
                    ? 'is-ok'
                    : 'is-current'
              }
            >
              <span className="steps-timeline__dot" />
              <div>
                <strong>{STAGE_LABEL[step.stage] ?? step.stage}</strong>
                <pre>{step.message}</pre>
              </div>
            </li>
          ))}
          {running ? (
            <li className="is-current">
              <span className="steps-timeline__dot" />
              <div>
                <strong>{STAGE_LABEL[job.stage] ?? job.stage}</strong>
                <pre>Working…</pre>
              </div>
            </li>
          ) : null}
        </ol>

        {job.error ? <p className="status status--bad">{job.error}</p> : null}

        <footer className="modal__foot">
          {job.prUrl ? (
            <a
              className="btn btn--secondary"
              href={job.prUrl}
              target="_blank"
              rel="noreferrer"
            >
              Open pull request
            </a>
          ) : null}
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            {running ? 'Run in background' : 'Close'}
          </button>
        </footer>
      </div>
    </div>
  );
}
