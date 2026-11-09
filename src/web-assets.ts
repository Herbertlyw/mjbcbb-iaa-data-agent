// Serve only the bundled UI files; URL paths never select arbitrary local files.
import { readFileSync } from "node:fs";

const bundled = [
  ["/", "index.html", "text/html"],
  ["/assets/styles.css", "styles.css", "text/css"],
  ["/assets/app.js", "app.js", "text/javascript"],
  ["/assets/view.js", "view.js", "text/javascript"],
  ["/assets/stream.js", "stream.js", "text/javascript"],
  ["/assets/examples.js", "examples.js", "text/javascript"],
  ["/assets/history.js", "history.js", "text/javascript"],
] as const;

const assets = new Map(
  bundled.map(([route, file, mime]) => [
    route as string,
    {
      body: readFileSync(new URL(`./web/${file}`, import.meta.url)),
      contentType: `${mime}; charset=utf-8`,
    },
  ]),
);

export function webAsset(pathname: string) {
  return assets.get(pathname);
}
