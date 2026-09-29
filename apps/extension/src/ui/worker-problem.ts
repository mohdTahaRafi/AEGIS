import type { WorkerProblem } from '../host/perception-client/client';

export function describeWorkerProblem(p: WorkerProblem): string {
  switch (p.kind) {
    case 'crashed':
      return 'crashed (replaced on the next step)';
    case 'timeout':
      return `stopped answering (${p.job}): replaced`;
    case 'restarted':
      return 'restarted';
    default:
      return `error ${p.code}`;
  }
}
