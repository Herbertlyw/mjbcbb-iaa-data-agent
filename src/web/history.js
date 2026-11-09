// Own one scoped history page request; stale replies cannot change another view.
export function createHistoryPager({ fetchPage, key, onChange, onPage = () => {} }) {
  let generation = 0;
  let scope = null;
  const state = { items: [], phase: "idle", error: "", next_cursor: null, has_more: false };

  function reset(nextScope) {
    generation++;
    scope = nextScope;
    Object.assign(state, { items: [], phase: "idle", error: "", next_cursor: null, has_more: false });
    onChange(state);
  }

  async function load({ refresh = false } = {}) {
    if (!refresh && state.phase === "loading") return false;
    const owner = ++generation;
    const requestedScope = scope;
    const cursor = refresh ? null : state.next_cursor;
    state.phase = "loading";
    state.error = "";
    onChange(state);
    try {
      const page = await fetchPage(requestedScope, cursor);
      if (owner !== generation) return false;
      const items = refresh ? [] : state.items;
      const merged = new Map(items.map((item) => [item[key], item]));
      for (const item of page.items) merged.set(item[key], item);
      Object.assign(state, { items: [...merged.values()], phase: "ready", error: "", next_cursor: page.next_cursor, has_more: page.has_more });
      onPage(page, requestedScope);
      onChange(state);
      return true;
    } catch (error) {
      if (owner !== generation) return false;
      state.phase = "error";
      state.error = error.message || "暂时无法读取历史。";
      onChange(state);
      return false;
    }
  }

  function upsert(item) {
    const current = state.items.findIndex((value) => value[key] === item[key]);
    if (current >= 0) state.items[current] = { ...state.items[current], ...item };
    else state.items.unshift(item);
    onChange(state);
  }

  return { state, reset, load, upsert };
}
