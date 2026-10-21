import { describe, it, expect } from "vitest";
import {
  capitalise,
  toTitleCase,
  truncate,
  maskEmail,
  maskPhone,
  slugify,
} from "./stringUtils.js";

// ---------------------------------------------------------------------------
// capitalise
// ---------------------------------------------------------------------------

describe("capitalise", () => {
  it("upper-cases the first character and leaves the rest unchanged", () => {
    expect(capitalise("hello world")).toBe("Hello world");
  });

  it("leaves an already-capitalised string unchanged", () => {
    expect(capitalise("Hello")).toBe("Hello");
  });

  it("works on a single character", () => {
    expect(capitalise("a")).toBe("A");
  });

  it("returns an empty string unchanged", () => {
    expect(capitalise("")).toBe("");
  });

  it("does not change the case of characters after the first", () => {
    expect(capitalise("hELLO")).toBe("HELLO");
  });

  it("handles unicode characters as the first character", () => {
    // Regular ASCII — quick sanity check that multi-char strings work
    expect(capitalise("über")).toBe("Über");
  });
});

// ---------------------------------------------------------------------------
// toTitleCase
// ---------------------------------------------------------------------------

describe("toTitleCase", () => {
  it("capitalises the first character of every word", () => {
    expect(toTitleCase("the quick brown fox")).toBe("The Quick Brown Fox");
  });

  it("returns an empty string unchanged", () => {
    expect(toTitleCase("")).toBe("");
  });

  it("handles a single-word input", () => {
    expect(toTitleCase("hello")).toBe("Hello");
  });

  it("preserves existing capitalisation in the middle of words", () => {
    // toTitleCase only touches the first char per word
    expect(toTitleCase("hELLO wORLD")).toBe("HELLO WORLD");
  });

  it("handles multiple spaces between words", () => {
    const result = toTitleCase("  foo   bar  ");
    // The non-\S+ parts (spaces) are not matched and stay in place
    expect(result).toBe("  Foo   Bar  ");
  });
});

// ---------------------------------------------------------------------------
// truncate
// ---------------------------------------------------------------------------

describe("truncate", () => {
  it("returns the original string when it fits within maxLen", () => {
    expect(truncate("Hi", 10)).toBe("Hi");
  });

  it("truncates and appends default ellipsis when string exceeds maxLen", () => {
    expect(truncate("Hello, world!", 8)).toBe("Hello, …");
  });

  it("truncates and appends a custom ellipsis", () => {
    expect(truncate("Hello, world!", 8, "...")).toBe("Hello...");
  });

  it("returns empty string for maxLen < 1", () => {
    expect(truncate("Hello", 0)).toBe("");
    expect(truncate("Hello", -5)).toBe("");
  });

  it("returns ellipsis sliced to limit when maxLen <= ellipsis length", () => {
    // Default ellipsis is 1 char ("…"), so maxLen=1 should return "…"
    expect(truncate("Hello", 1)).toBe("…");
    // With 3-char ellipsis "...", maxLen=2 → "..".slice(0,2) = ".."
    expect(truncate("Hello", 2, "...")).toBe("..");
  });

  it("handles NaN maxLen as 0 (returns empty string)", () => {
    expect(truncate("Hello", NaN)).toBe("");
  });

  it("handles Infinity maxLen as 0 (returns empty string)", () => {
    expect(truncate("Hello", Infinity)).toBe("");
  });

  it("exactly fits maxLen — no truncation occurs", () => {
    expect(truncate("Hello", 5)).toBe("Hello");
  });
});

// ---------------------------------------------------------------------------
// maskEmail
// ---------------------------------------------------------------------------

describe("maskEmail", () => {
  it("masks the middle of a local part with 3+ chars", () => {
    expect(maskEmail("alice@example.com")).toBe("a***e@example.com");
  });

  it("masks a 2-char local part (shows first, masks second)", () => {
    expect(maskEmail("ab@example.com")).toBe("a*@example.com");
  });

  it("masks a 1-char local part (appends ***)", () => {
    expect(maskEmail("a@example.com")).toBe("a***@example.com");
  });

  it("preserves the domain unchanged", () => {
    expect(maskEmail("user@my.domain.co.uk")).toContain("@my.domain.co.uk");
  });

  it("returns the original string when there is no @ sign", () => {
    expect(maskEmail("notanemail")).toBe("notanemail");
  });

  it("returns the original string when @ is the first character", () => {
    // atIndex === 0, no local part
    expect(maskEmail("@example.com")).toBe("@example.com");
  });

  it("handles an empty string", () => {
    expect(maskEmail("")).toBe("");
  });

  it("masks a longer local part, preserving only first and last chars", () => {
    // "longlocal" → "l*******l"
    expect(maskEmail("longlocal@x.com")).toBe("l*******l@x.com");
  });
});

// ---------------------------------------------------------------------------
// maskPhone
// ---------------------------------------------------------------------------

describe("maskPhone", () => {
  it("masks the middle digits with default keep values (3 start, 2 end)", () => {
    expect(maskPhone("07911123456")).toBe("079******56");
  });

  it("respects custom keepStart and keepEnd", () => {
    expect(maskPhone("07911123456", 4, 4)).toBe("0791***3456");
  });

  it("strips non-digit characters before masking", () => {
    // All non-digits stripped: "+447911123456" → "447911123456" (12 digits)
    // keep 3 start + 2 end = 7 masked
    expect(maskPhone("+44 7911 123456")).toBe("447*******56");
  });

  it("returns *** when there are no digits", () => {
    expect(maskPhone("no-digits-here")).toBe("***");
    expect(maskPhone("")).toBe("***");
  });

  it("handles a phone number exactly equal to keepStart + keepEnd digits", () => {
    // 5 digits, keep 3 + 2 = 5, so middle has 0 masked chars
    expect(maskPhone("12345", 3, 2)).toBe("12345");
  });

  it("handles keepEnd = 0 (show only start)", () => {
    expect(maskPhone("1234567890", 3, 0)).toBe("123*******");
  });
});

// ---------------------------------------------------------------------------
// slugify
// ---------------------------------------------------------------------------

describe("slugify", () => {
  it("converts a plain string to lowercase with hyphens", () => {
    expect(slugify("Hello, World!")).toBe("hello-world");
  });

  it("strips leading and trailing whitespace/hyphens", () => {
    expect(slugify("  The Quick Brown Fox  ")).toBe("the-quick-brown-fox");
  });

  it("strips diacritics and normalises unicode", () => {
    expect(slugify("Ångström & Über")).toBe("angstrom-uber");
  });

  it("leaves an already-valid slug unchanged", () => {
    expect(slugify("already-a-slug")).toBe("already-a-slug");
  });

  it("collapses multiple non-alphanumeric characters into a single hyphen", () => {
    expect(slugify("foo---bar   baz")).toBe("foo-bar-baz");
  });

  it("returns an empty string for an all-symbol input", () => {
    expect(slugify("!@#$%^&*()")).toBe("");
  });

  it("handles an empty string", () => {
    expect(slugify("")).toBe("");
  });

  it("handles a string with only spaces", () => {
    expect(slugify("   ")).toBe("");
  });

  it("handles numbers in the input", () => {
    expect(slugify("Version 2.0 Release")).toBe("version-2-0-release");
  });
});
