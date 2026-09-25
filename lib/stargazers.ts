import { nameForIndex } from "./names";
import type { Tier } from "./rarity";

export type Stargazer = {
  login: string;
  avatarUrl: string;
  profileUrl: string;
  tier?: Tier; // real rarity from the profile (server-computed)
  contributor?: boolean; // contributed to the tracked repo
  commits?: number; // commits to the tracked repo
  followers?: number;
};

/** Login for house i — real stargazer if known, else the placeholder name. */
export function nameForHouse(i: number, list: Stargazer[] | null): string {
  return list?.[i]?.login ?? nameForIndex(i);
}
