import type { Metadata, Viewport } from "next";
import { Nunito } from "next/font/google";
import "./globals.css";
import { fetchOwner, ownerLogin } from "@/lib/owner";
import { siteUrl } from "@/lib/site";

// One cozy, highly readable rounded face for the WHOLE site (self-hosted via
// next/font — no external requests, no layout shift).
const nunito = Nunito({
  subsets: ["latin"],
  variable: "--font-nunito",
  display: "swap",
});

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Draw under the notch/rounded corners so the 3D scene is truly fullscreen;
  // the HUD keeps clear of the cutouts via env(safe-area-inset-*).
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0b1320" },
    { media: "(prefers-color-scheme: light)", color: "#3a2712" },
  ],
};

// SEO is built from the real GitHub owner — nothing hardcoded.
export async function generateMetadata(): Promise<Metadata> {
  const owner = await fetchOwner();
  const login = owner?.login ?? ownerLogin();
  const name = owner?.name ?? login;
  const base = siteUrl();

  const title = `${name} (@${login}) — Developer Portfolio`;
  const description =
    owner?.bio?.replace(/\s+/g, " ").trim() ||
    `${name}'s developer portfolio — a living GitHub Star Tree where every stargazer becomes a house on a floating low-poly island.`;
  const keywords = [
    name,
    login,
    "portfolio",
    "developer",
    "software engineer",
    "GitHub",
    "open source",
    "three.js",
    "web developer",
    owner?.location ?? "",
  ].filter(Boolean);

  return {
    metadataBase: new URL(base),
    title: { default: title, template: `%s — ${name}` },
    description,
    keywords,
    applicationName: `${name} — Portfolio`,
    authors: [{ name, url: owner?.htmlUrl ?? `https://github.com/${login}` }],
    creator: name,
    publisher: name,
    alternates: { canonical: "/" },
    formatDetection: { telephone: false, email: false, address: false },
    robots: {
      index: true,
      follow: true,
      googleBot: { index: true, follow: true, "max-image-preview": "large" },
    },
    icons: { icon: "/icon.svg", shortcut: "/icon.svg", apple: "/icon.svg" },
    openGraph: {
      type: "website",
      url: base,
      siteName: `${name} — Portfolio`,
      title,
      description,
      locale: "en_US",
      alternateLocale: ["de_DE", "it_IT"],
      // The dynamic app/opengraph-image.tsx card is picked up automatically.
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      creator: owner?.twitter ? `@${owner.twitter}` : undefined,
    },
    category: "technology",
  };
}

// JSON for an inline <script>: escape "<" so text from the GitHub profile
// (bio, company, …) can never close the script tag early.
function inlineJson(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const owner = await fetchOwner();
  const login = owner?.login ?? ownerLogin();
  const base = siteUrl();

  // Structured data so search engines (and rich results) understand both the
  // person AND the site itself.
  const websiteLd = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: `${owner?.name ?? login} — Portfolio`,
    url: base,
    description:
      "A living GitHub Star Tree: every stargazer becomes a house on a floating island with real-time Alpine weather, a real sun and moon, and seasons.",
    inLanguage: ["en", "de", "it"],
    image: `${base}/opengraph-image`,
    author: { "@type": "Person", name: owner?.name ?? login },
  };
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Person",
    name: owner?.name ?? login,
    alternateName: login,
    url: base,
    image: owner?.avatarUrl,
    description: owner?.bio ?? undefined,
    jobTitle: "Software Developer",
    knowsAbout: ["Three.js", "React", "WebGL", "TypeScript", "Next.js", "Shaders"],
    worksFor: owner?.company ? { "@type": "Organization", name: owner.company } : undefined,
    address: owner?.location
      ? { "@type": "PostalAddress", addressLocality: owner.location }
      : undefined,
    sameAs: [
      owner?.htmlUrl ?? `https://github.com/${login}`,
      owner?.blog ? (owner.blog.startsWith("http") ? owner.blog : `https://${owner.blog}`) : null,
      owner?.twitter ? `https://x.com/${owner.twitter}` : null,
    ].filter(Boolean),
  };

  return (
    <html lang="en" className={nunito.variable}>
      <head>
        {/* Stargazer avatars are fetched client-side at runtime. */}
        <link rel="preconnect" href="https://avatars.githubusercontent.com" crossOrigin="" />
        <link rel="dns-prefetch" href="https://avatars.githubusercontent.com" />
      </head>
      <body className="font-sans">
        {children}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: inlineJson(jsonLd) }}
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: inlineJson(websiteLd) }}
        />
      </body>
    </html>
  );
}
