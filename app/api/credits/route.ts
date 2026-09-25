import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { guardApi } from "@/lib/apiGuard";

// CREDITS.md (repo root) is the single source of truth for asset attributions.
// Parse its markdown table server-side; malformed rows are skipped, never fatal.
export const revalidate = 3600;

export type Credit = {
  model: string;
  author: string;
  source: string;
  license: string;
};

function isSeparatorCell(cell: string): boolean {
  return /^:?-{3,}:?$/.test(cell);
}

export async function GET(req: Request) {
  const blocked = guardApi(req, { key: "credits", limit: 30, windowMs: 60_000 });
  if (blocked) return blocked;

  try {
    const raw = await fs.readFile(path.join(process.cwd(), "CREDITS.md"), "utf8");
    const credits: Credit[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim().startsWith("|")) continue;
      const cells = line.split("|").map((c) => c.trim());
      // cells[0] is the empty chunk before the leading pipe.
      const [, model, author = "", source = "", license = ""] = cells;
      if (!model) continue;
      if (isSeparatorCell(model)) continue;
      if (model.toLowerCase() === "model") continue; // header row
      credits.push({ model, author, source, license });
    }
    return NextResponse.json({ credits });
  } catch {
    return NextResponse.json({ credits: [] });
  }
}
