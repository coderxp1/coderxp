/**
 * Project templates for CoderXP M2 Workspace Alpha.
 *
 * Commit 2 scope: one deterministic static HTML/CSS/JavaScript template
 * and template availability metadata.
 *
 * Only the static-html template is currently available. React and Next.js
 * templates are listed as unavailable with truthful reasons.
 *
 * The static template uses a small Node built-in HTTP server (server.mjs)
 * with no external dependencies, no CDN, and no runtime downloads.
 */

import type { ProjectTemplate, TemplateMetadata, ProjectTemplateId } from "./types";

// ---------------------------------------------------------------------------
// Static HTML template — file contents
// ---------------------------------------------------------------------------

const STATIC_INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Static Project</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <main>
    <h1>Hello from CoderXP</h1>
    <p>This is a static HTML project. Edit the files and refresh to see changes.</p>
    <button id="counter-btn">Click me: 0</button>
  </main>
  <script src="script.js"></script>
</body>
</html>
`;

const STATIC_STYLE_CSS = `* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: system-ui, -apple-system, sans-serif;
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 100vh;
  background: #0f172a;
  color: #e2e8f0;
}

main {
  text-align: center;
  padding: 2rem;
}

h1 {
  font-size: 2rem;
  margin-bottom: 0.5rem;
}

p {
  color: #94a3b8;
  margin-bottom: 1.5rem;
}

button {
  padding: 0.75rem 1.5rem;
  font-size: 1rem;
  border: none;
  border-radius: 0.5rem;
  background: #3b82f6;
  color: white;
  cursor: pointer;
  transition: background 0.2s;
}

button:hover {
  background: #2563eb;
}
`;

const STATIC_SCRIPT_JS = `const btn = document.getElementById("counter-btn");
let count = 0;

btn.addEventListener("click", () => {
  count++;
  btn.textContent = "Click me: " + count;
});
`;

const STATIC_SERVER_MJS = `import { createServer } from "node:http";
import { readFile, stat, realpath } from "node:fs/promises";
import { join, normalize, extname, isAbsolute, relative, sep, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

function parsePort(value) {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) {
    return parsed;
  }
  return 3000;
}

const PORT = parsePort(process.env.PORT);
const HOST = "0.0.0.0";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function isInsideRoot(root, target) {
  const rel = relative(root, target);
  return (
    rel !== "" &&
    !isAbsolute(rel) &&
    rel !== ".." &&
    !rel.startsWith(".." + sep)
  );
}

function createStaticServer(rootDir) {
  return createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, "http://localhost");
    } catch {
      res.writeHead(400);
      res.end("400 Bad Request");
      return;
    }

    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400);
      res.end("400 Bad Request");
      return;
    }

    if (pathname === "/") {
      pathname = "/index.html";
    }

    // Step 1: Resolve the configured root to its real path.
    let realRoot;
    try {
      realRoot = await realpath(rootDir);
    } catch {
      res.writeHead(500);
      res.end("500 Internal Server Error");
      return;
    }

    // Step 2: Resolve the requested target lexically.
    const lexicalTarget = normalize(join(rootDir, pathname));

    // Step 3: Perform the lexical boundary check.
    if (!isInsideRoot(realRoot, lexicalTarget)) {
      res.writeHead(403);
      res.end("403 Forbidden");
      return;
    }

    // Step 4: Resolve the requested target with realpath().
    let realTarget;
    try {
      realTarget = await realpath(lexicalTarget);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        res.writeHead(404);
        res.end("404 Not Found");
      } else {
        res.writeHead(500);
        res.end("500 Internal Server Error");
      }
      return;
    }

    // Step 5: Perform the boundary check again against the real root.
    if (!isInsideRoot(realRoot, realTarget)) {
      res.writeHead(403);
      res.end("403 Forbidden");
      return;
    }

    try {
      const stats = await stat(realTarget);

      if (stats.isDirectory()) {
        res.writeHead(403);
        res.end("403 Forbidden");
        return;
      }

      // Step 6: Read only the verified real target.
      const data = await readFile(realTarget);
      const ext = extname(realTarget);
      const mime = MIME_TYPES[ext] || "application/octet-stream";

      res.writeHead(200, { "Content-Type": mime });
      res.end(data);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        res.writeHead(404);
        res.end("404 Not Found");
      } else {
        res.writeHead(500);
        res.end("500 Internal Server Error");
      }
    }
  });
}

function startServer(server, port, host) {
  server.listen(port, host, () => {
    console.log("Server running at http://" + host + ":" + port);
  });
}

export { createStaticServer, startServer, parsePort };

// Start listening only when executed as the main module.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const server = createStaticServer(__dirname);
  startServer(server, PORT, HOST);
}
`;

const STATIC_PACKAGE_JSON = JSON.stringify(
  {
    name: "coderxp-static-project",
    version: "1.0.0",
    private: true,
    scripts: {
      dev: "node server.mjs",
    },
  },
  null,
  2,
) + "\n";

const STATIC_PACKAGE_LOCK_JSON = JSON.stringify(
  {
    name: "coderxp-static-project",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": {
        name: "coderxp-static-project",
        version: "1.0.0",
      },
    },
  },
  null,
  2,
) + "\n";

// ---------------------------------------------------------------------------
// React + TypeScript template — file contents
// ---------------------------------------------------------------------------

const REACT_INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>CoderXP React Project</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;

const REACT_PACKAGE_JSON = JSON.stringify(
  {
    name: "coderxp-react-project",
    version: "1.0.0",
    private: true,
    type: "module",
    scripts: {
      dev: "vite --host 0.0.0.0",
      build: "tsc && vite build",
      preview: "vite preview",
    },
    dependencies: {
      react: "^19.0.0",
      "react-dom": "^19.0.0",
    },
    devDependencies: {
      "@types/react": "^19.0.0",
      "@types/react-dom": "^19.0.0",
      "@vitejs/plugin-react": "^4.3.0",
      typescript: "^5.6.0",
      vite: "^6.0.0",
    },
  },
  null,
  2,
) + "\n";

const REACT_TSCONFIG_JSON = JSON.stringify(
  {
    compilerOptions: {
      target: "ES2020",
      useDefineForClassFields: true,
      lib: ["ES2020", "DOM", "DOM.Iterable"],
      module: "ESNext",
      skipLibCheck: true,
      moduleResolution: "bundler",
      allowImportingTsExtensions: true,
      isolatedModules: true,
      moduleDetection: "force",
      noEmit: true,
      jsx: "react-jsx",
      strict: true,
      noUnusedLocals: true,
      noUnusedParameters: true,
      noFallthroughCasesInSwitch: true,
    },
    include: ["src"],
  },
  null,
  2,
) + "\n";

const REACT_VITE_CONFIG_TS = `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
  },
});
`;

const REACT_MAIN_TSX = `import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
`;

const REACT_APP_TSX = `import { useState } from "react";

export default function App() {
  const [count, setCount] = useState(0);

  return (
    <main>
      <h1>CoderXP</h1>
      <p>Edit <code>src/App.tsx</code> and press Run to see changes.</p>
      <button onClick={() => setCount((c) => c + 1)}>
        Count: {count}
      </button>
    </main>
  );
}
`;

const REACT_INDEX_CSS = `:root {
  font-family: system-ui, -apple-system, sans-serif;
  color-scheme: dark;
}

* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  min-height: 100vh;
  display: flex;
  justify-content: center;
  align-items: center;
  background: #0f172a;
  color: #e2e8f0;
}

main {
  text-align: center;
  padding: 2rem;
}

h1 {
  font-size: 2rem;
  margin-bottom: 0.5rem;
}

p {
  color: #94a3b8;
  margin-bottom: 1.5rem;
}

code {
  background: #1e293b;
  padding: 0.1rem 0.3rem;
  border-radius: 0.25rem;
  font-size: 0.9em;
}

button {
  padding: 0.75rem 1.5rem;
  font-size: 1rem;
  border: none;
  border-radius: 0.5rem;
  background: #3b82f6;
  color: white;
  cursor: pointer;
  transition: background 0.2s;
}

button:hover {
  background: #2563eb;
}
`;

// ---------------------------------------------------------------------------
// Next.js + TypeScript template — file contents
// ---------------------------------------------------------------------------

const NEXT_PACKAGE_JSON = JSON.stringify(
  {
    name: "coderxp-next-project",
    version: "1.0.0",
    private: true,
    scripts: {
      dev: "next dev -H 0.0.0.0",
      build: "next build",
      start: "next start",
    },
    dependencies: {
      next: "^15.1.0",
      react: "^19.0.0",
      "react-dom": "^19.0.0",
    },
    devDependencies: {
      "@types/node": "^22.0.0",
      "@types/react": "^19.0.0",
      "@types/react-dom": "^19.0.0",
      typescript: "^5.6.0",
    },
  },
  null,
  2,
) + "\n";

const NEXT_TSCONFIG_JSON = JSON.stringify(
  {
    compilerOptions: {
      target: "ES2020",
      lib: ["ES2020", "DOM", "DOM.Iterable"],
      module: "ESNext",
      skipLibCheck: true,
      moduleResolution: "bundler",
      allowImportingTsExtensions: true,
      isolatedModules: true,
      moduleDetection: "force",
      noEmit: true,
      jsx: "preserve",
      strict: true,
      noUnusedLocals: true,
      noUnusedParameters: true,
      noFallthroughCasesInSwitch: true,
    },
    include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
    exclude: ["node_modules"],
  },
  null,
  2,
) + "\n";

const NEXT_CONFIG_TS = `import type { NextConfig } from "next";

const nextConfig: NextConfig = {};

export default nextConfig;
`;

const NEXT_ENV_D_TS = `/// <reference types="next" />
/// <reference types="next/image-types/global" />

// NOTE: This file should not be edited
// see https://nextjs.org/docs/app/api-reference/config/typescript for more information.
`;

const NEXT_LAYOUT_TSX = `import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CoderXP Next.js Project",
  description: "Built with CoderXP",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`;

const NEXT_PAGE_TSX = `import { useState } from "react";

export default function Home() {
  const [count, setCount] = useState(0);

  return (
    <main>
      <h1>CoderXP</h1>
      <p>Edit <code>app/page.tsx</code> and press Run to see changes.</p>
      <button onClick={() => setCount((c) => c + 1)}>
        Count: {count}
      </button>
    </main>
  );
}
`;

const NEXT_GLOBALS_CSS = `:root {
  font-family: system-ui, -apple-system, sans-serif;
  color-scheme: dark;
}

* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  min-height: 100vh;
  display: flex;
  justify-content: center;
  align-items: center;
  background: #0f172a;
  color: #e2e8f0;
}

main {
  text-align: center;
  padding: 2rem;
}

h1 {
  font-size: 2rem;
  margin-bottom: 0.5rem;
}

p {
  color: #94a3b8;
  margin-bottom: 1.5rem;
}

code {
  background: #1e293b;
  padding: 0.1rem 0.3rem;
  border-radius: 0.25rem;
  font-size: 0.9em;
}

button {
  padding: 0.75rem 1.5rem;
  font-size: 1rem;
  border: none;
  border-radius: 0.5rem;
  background: #3b82f6;
  color: white;
  cursor: pointer;
  transition: background 0.2s;
}

button:hover {
  background: #2563eb;
}
`;

// ---------------------------------------------------------------------------
// Template definitions
// ---------------------------------------------------------------------------

/**
 * The static HTML template.
 *
 * Contains: index.html, style.css, script.js, server.mjs, package.json,
 * package-lock.json.
 *
 * Runtime: Node built-in HTTP server (no external dependencies, no CDN,
 * no runtime downloads). Binds to 0.0.0.0 with process.env.PORT fallback.
 * Prevents path traversal, serves index.html for /, uses basic MIME types,
 * avoids directory listing, returns authentic HTTP status codes.
 */
export const STATIC_HTML_TEMPLATE: ProjectTemplate = {
  id: "static-html",
  name: "Static HTML",
  available: true,
  files: [
    { path: "index.html", contents: STATIC_INDEX_HTML },
    { path: "style.css", contents: STATIC_STYLE_CSS },
    { path: "script.js", contents: STATIC_SCRIPT_JS },
    { path: "server.mjs", contents: STATIC_SERVER_MJS },
    { path: "package.json", contents: STATIC_PACKAGE_JSON },
    { path: "package-lock.json", contents: STATIC_PACKAGE_LOCK_JSON },
  ],
};

/**
 * All project templates indexed by ID.
 */
export const PROJECT_TEMPLATES: Record<ProjectTemplateId, ProjectTemplate> = {
  "static-html": STATIC_HTML_TEMPLATE,
  "react-ts": {
    id: "react-ts",
    name: "React + TypeScript",
    available: true,
    files: [
      { path: "package.json", contents: REACT_PACKAGE_JSON },
      { path: "tsconfig.json", contents: REACT_TSCONFIG_JSON },
      { path: "vite.config.ts", contents: REACT_VITE_CONFIG_TS },
      { path: "index.html", contents: REACT_INDEX_HTML },
      { path: "src/main.tsx", contents: REACT_MAIN_TSX },
      { path: "src/App.tsx", contents: REACT_APP_TSX },
      { path: "src/index.css", contents: REACT_INDEX_CSS },
    ],
  },
  "nextjs-ts": {
    id: "nextjs-ts",
    name: "Next.js + TypeScript",
    available: true,
    files: [
      { path: "package.json", contents: NEXT_PACKAGE_JSON },
      { path: "tsconfig.json", contents: NEXT_TSCONFIG_JSON },
      { path: "next.config.ts", contents: NEXT_CONFIG_TS },
      { path: "next-env.d.ts", contents: NEXT_ENV_D_TS },
      { path: "app/layout.tsx", contents: NEXT_LAYOUT_TSX },
      { path: "app/page.tsx", contents: NEXT_PAGE_TSX },
      { path: "app/globals.css", contents: NEXT_GLOBALS_CSS },
    ],
  },
};

/**
 * Template availability metadata for UI consumption.
 * Only the static template is currently available.
 */
export const TEMPLATE_METADATA: TemplateMetadata[] = [
  {
    id: "static-html",
    name: "Static HTML",
    available: true,
  },
  {
    id: "react-ts",
    name: "React + TypeScript",
    available: true,
  },
  {
    id: "nextjs-ts",
    name: "Next.js + TypeScript",
    available: true,
  },
];

/**
 * Returns the template definition for the given ID, or undefined.
 */
export function getTemplate(id: ProjectTemplateId): ProjectTemplate | undefined {
  return PROJECT_TEMPLATES[id];
}

/**
 * Returns true if the template is available for project creation.
 */
export function isTemplateAvailable(id: ProjectTemplateId): boolean {
  const template = PROJECT_TEMPLATES[id];
  return template ? template.available : false;
}
