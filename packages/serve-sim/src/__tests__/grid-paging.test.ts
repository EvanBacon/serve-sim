import { describe, expect, test } from "bun:test";
import { parseGridPaging } from "../middleware";

describe("parseGridPaging", () => {
  test("no query → unpaginated (whole list)", () => {
    expect(parseGridPaging("/grid/api")).toEqual({ limit: null, offset: 0 });
  });

  test("no limit param → unpaginated even with other params", () => {
    expect(parseGridPaging("/grid/api?device=ABC")).toEqual({ limit: null, offset: 0 });
  });

  test("parses limit and offset", () => {
    expect(parseGridPaging("/grid/api?limit=60&offset=120")).toEqual({ limit: 60, offset: 120 });
  });

  test("clamps limit to [1, 1000] and floors offset at 0", () => {
    expect(parseGridPaging("/grid/api?limit=0").limit).toBe(1);
    expect(parseGridPaging("/grid/api?limit=99999").limit).toBe(1000);
    expect(parseGridPaging("/grid/api?limit=60&offset=-5").offset).toBe(0);
  });

  test("ignores non-numeric values", () => {
    expect(parseGridPaging("/grid/api?limit=abc")).toEqual({ limit: null, offset: 0 });
    expect(parseGridPaging("/grid/api?limit=60&offset=x").offset).toBe(0);
  });
});
