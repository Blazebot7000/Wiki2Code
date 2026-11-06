import type { SetupState } from '@org/contracts';
import { useEffect, useState } from 'react';
import { api } from './api';
import { Wizard } from './wizard';
import { Workspace } from './workspace/workspace';

export default function App() {
  const [state, setState] = useState<SetupState>();
  const [error, setError] = useState<string>();

  const load = () => {
    setError(undefined);
    void api
      .setup()
      .then(setState)
      .catch((cause) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      );
  };

  useEffect(() => {
    load();
  }, []);

  if (error) {
    return (
      <div className="boot boot--error">
        <h1>Wiki2Code</h1>
        <p>{error}</p>
        <button type="button" className="btn btn--primary" onClick={load}>
          Retry
        </button>
      </div>
    );
  }

  if (!state) {
    return (
      <div className="boot">
        <span className="spinner spinner--large" />
        <p>Starting Wiki2Code…</p>
      </div>
    );
  }

  if (!state.completed) {
    return <Wizard initial={state} onDone={setState} />;
  }

  return (
    <Workspace
      initial={state}
      onReset={() => {
        void api.setup().then(setState);
      }}
    />
  );
}
