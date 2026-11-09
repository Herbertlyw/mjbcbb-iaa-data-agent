// Present release-bound questions without executing them or supplying result values.
export function selectExamples(questions, category) {
  return category ? questions.filter((item) => item.category === category) : questions;
}

export function releaseDescription(demo) {
  if (demo.release_state === "invalid") return "示例目录与发布信息不一致，请重新绑定知识目录。";
  if (!demo.release) return "尚未绑定数据发布。请先装载合成数据、绑定知识目录并发布新鲜度。";
  return `${demo.release.start_date} 至 ${demo.release.as_of} · ${demo.release.timezone} · 数据截止不代表所有 cohort 已成熟。`;
}

export function mountExamples(document, demo, onSelect) {
  const container = document.querySelector("#prompts");
  const categories = document.querySelector("#example-categories");
  const detail = document.querySelector("#example-detail");
  const scope = document.querySelector("#example-scope");
  const note = document.querySelector("#example-note");
  const question = document.querySelector("#example-question");
  const fill = document.querySelector("#use-example");
  const count = document.querySelector("#example-count");
  let selected = null;
  container.replaceChildren();
  categories.replaceChildren();
  detail.hidden = true;
  const render = (category) => {
    selected = null;
    detail.hidden = true;
    container.replaceChildren();
    const items = selectExamples(demo.questions, category);
    count.textContent = `${items.length} 个问题`;
    for (const item of items) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "example";
      button.textContent = item.label;
      button.setAttribute("aria-pressed", "false");
      button.setAttribute("aria-controls", "example-detail");
      button.addEventListener("click", () => {
        for (const current of container.querySelectorAll("button")) current.setAttribute("aria-pressed", "false");
        button.setAttribute("aria-pressed", "true");
        selected = item;
        scope.textContent = item.scope || "可修改后发送";
        note.textContent = item.note || "";
        question.textContent = item.text;
        detail.hidden = false;
      });
      container.append(button);
    }
  };
  for (const category of demo.categories || []) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = category.label;
    button.setAttribute("aria-pressed", "false");
    button.addEventListener("click", () => {
      for (const current of categories.querySelectorAll("button")) current.setAttribute("aria-pressed", "false");
      button.setAttribute("aria-pressed", "true");
      render(category.id);
    });
    categories.append(button);
  }
  fill.addEventListener("click", () => { if (selected) onSelect(selected); });
  if (demo.categories?.length) categories.querySelector("button").click();
  else render(null);
}
