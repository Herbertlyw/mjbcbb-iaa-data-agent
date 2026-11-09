// Own one event stream at a time; reconnect only from the last contiguous event.
export function createJobStream({
  createSource,
  schedule,
  cancelSchedule,
  onEvent,
  onConnection,
  onTerminal,
}) {
  let generation = 0;
  let current = null;
  let timer = null;
  let cursor = 0;

  function stop() {
    generation++;
    current?.close();
    current = null;
    if (timer !== null) cancelSchedule(timer);
    timer = null;
  }

  function start(jobId, after = 0) {
    stop();
    cursor = after;
    const owner = generation;
    let retry = 0;
    function connect() {
      if (owner !== generation) return;
      const source = createSource(`/api/jobs/${encodeURIComponent(jobId)}/events?after=${cursor}`);
      current = source;
      let reconnecting = false;
      const active = () => owner === generation && current === source;
      const reconnect = () => {
        if (!active() || reconnecting) return;
        reconnecting = true;
        source.close();
        onConnection("reconnecting");
        timer = schedule(
          () => {
            timer = null;
            if (active()) connect();
          },
          Math.min(500 * 2 ** retry++, 5000),
        );
      };
      source.onopen = () => {
        if (active()) {
          retry = 0;
          onConnection("connected");
        }
      };
      source.onerror = reconnect;
      source.onmessage = async (event) => {
        if (!active() || reconnecting) return;
        let body;
        try {
          body = JSON.parse(event.data);
        } catch {
          reconnect();
          return;
        }
        const seq = Number(body.seq ?? event.lastEventId);
        if (!Number.isSafeInteger(seq) || seq < 1 || typeof body.type !== "string") {
          reconnect();
          return;
        }
        if (seq <= cursor) return;
        if (seq !== cursor + 1) {
          reconnect();
          return;
        }
        cursor = seq;
        onEvent(body);
        if (["job_finished", "job_failed", "job_cancelled", "job_timed_out"].includes(body.type)) {
          source.close();
          try {
            await onTerminal(jobId);
            if (active()) {
              current = null;
              onConnection("settled");
            }
          } catch {
            if (active()) {
              cursor = seq - 1;
              reconnect();
            }
          }
        }
      };
    }
    connect();
  }
  return {
    start,
    stop,
    get cursor() {
      return cursor;
    },
  };
}
