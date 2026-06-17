import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PipelineBoardSection } from './PipelineBoardSection';

const board = {
  stories: [
    { story_id: 'STORY-A', status: 'in_progress' as const, depends_on: [] },
    { story_id: 'STORY-B', status: 'todo' as const, depends_on: ['STORY-A'] },
  ],
};

const admission = {
  stories: [
    { story_id: 'STORY-B', block_reason: 'wave_closed' as const, human_hold: false, supervisor_proposed_hold: false },
  ],
  waves: [{ wave_id: 'WAVE-0', status: 'closed' as const }],
  maxWipPerEpic: 3,
  onHoldConfirm: () => {},
  onReleaseConfirm: () => {},
  onWipChange: () => {},
};

describe('STORY-032.7 pipeline board hosts admission', () => {
  it('story_manager_nav_removed_admission_in_pipeline_board', () => {
    render(<PipelineBoardSection board={board} admission={admission} />);
    // the admission view lives INSIDE the pipeline board surface
    const section = screen.getByTestId('pipeline-board-with-admission');
    expect(section).toBeTruthy();
    expect(screen.getByTestId('admission-in-board')).toBeTruthy();
    // the board's stories and the admission block reason both render in one surface
    expect(screen.getByText('STORY-A')).toBeTruthy();
    expect(screen.getByText(/wave_closed/i)).toBeTruthy();
    // there is NO standalone "Story Manager" nav entry / link
    expect(screen.queryByRole('link', { name: /story manager/i })).toBeNull();
    expect(screen.queryByRole('navigation', { name: /story manager/i })).toBeNull();
  });
});
