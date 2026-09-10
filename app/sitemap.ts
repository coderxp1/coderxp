import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  const routes = [
    "",
    "/features",
    "/workspace",
    "/models",
    "/bring-your-own-key",
    "/local-models",
    "/pricing",
    "/docs",
    "/api",
    "/security",
    "/about",
    "/contact",
    "/privacy",
    "/terms",
    "/cookies",
  ];

  const baseUrl = "https://coderxp.pro";

  return routes.map((route) => ({
    url: `${baseUrl}${route}`,
    lastModified: new Date(),
    changeFrequency: "monthly" as const,
    priority: route === "" ? 1 : 0.8,
  }));
}