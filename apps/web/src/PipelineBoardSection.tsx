import { PipelineBoard, type PipelineBoardProps } from './PipelineBoard';
import { AdmissionPanel, type AdmissionPanelProps } from './AdmissionPanel';

/**
 * STORY-032.7 — Pipeline Board hosts the admission view.
 *
 * The Story Manager is a deterministic admission controller (EPIC-023), not a thing
 * the operator drives, so it has NO standalone nav entry. Its display surface IS the
 * Pipeline Board: the kanban lanes + DAG live here, and directly below them the
 * admission-control panel (why a story cannot enter yet) with per-card hold/release
 * as the only operator action. EPIC-023's deterministic backend is unchanged — only
 * the UI is merged. Design: docs/architecture/16_MODEL_REGISTRY_AND_INTROSPECTION.md.
 */
export interface PipelineBoardSectionProps {
  board: PipelineBoardProps;
  admission: AdmissionPanelProps;
}

export function PipelineBoardSection({ board, admission }: PipelineBoardSectionProps): JSX.Element {
  return (
    <div data-testid="pipeline-board-with-admission">
      <PipelineBoard {...board} />
      {/* Admission control lives inside the board — no separate Story Manager nav. */}
      <div data-testid="admission-in-board" style={{ marginTop: 12 }}>
        <AdmissionPanel {...admission} />
      </div>
    </div>
  );
}
