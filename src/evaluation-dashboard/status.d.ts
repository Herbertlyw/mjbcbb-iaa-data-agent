export function displayStatus(record: {
  verdict?: string;
  dispatched?: number | null;
  job_id?: string;
  steps?: unknown[];
  judgement?: string;
}): string | undefined;
