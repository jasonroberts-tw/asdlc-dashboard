import { describe, expect, it } from "vitest";
import { issueRefPattern, splitIssueRefs, type IssueRefs } from "./markdown";

describe("splitIssueRefs", () => {
  const known = new Set(["bomv2-la7", "bomv2-la7.8", "bomv2-40be"]);
  const refs: IssueRefs = {
    pattern: issueRefPattern("bomv2")!,
    isKnown: (id) => known.has(id),
  };

  it("splits text around known IDs, hierarchical ones included", () => {
    expect(splitIssueRefs("See bomv2-la7.8, then bomv2-40be.", refs)).toEqual([
      "See ",
      { id: "bomv2-la7.8" },
      ", then ",
      { id: "bomv2-40be" },
      ".",
    ]);
  });

  it("links an ID at the very start of the text", () => {
    expect(splitIssueRefs("bomv2-la7 is done", refs)).toEqual([{ id: "bomv2-la7" }, " is done"]);
  });

  it("leaves unknown IDs and IDs inside longer words alone", () => {
    expect(splitIssueRefs("bomv2-zzz and xbomv2-la7 and bomv2-la7-x", refs)).toEqual([
      "bomv2-zzz and xbomv2-la7 and bomv2-la7-x",
    ]);
  });

  it("escapes prefixes that contain regex characters", () => {
    const pattern = issueRefPattern("a.b")!;
    expect("axb-1".match(pattern)).toBeNull();
    expect("a.b-1".match(pattern)).not.toBeNull();
  });

  it("has no pattern without a prefix", () => {
    expect(issueRefPattern("")).toBeNull();
  });
});
