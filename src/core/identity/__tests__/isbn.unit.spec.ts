import {
  isValidIsbn10,
  isValidIsbn13,
  normaliseIsbn,
} from "../../identity";

describe("normaliseIsbn", () => {
  it.each([
    ["9780306406157", "9780306406157"],
    ["978-0-306-40615-7", "9780306406157"],
    ["978 0 306 40615 7", "9780306406157"],
    [" 978-0306406157 ", "9780306406157"],
    // En dash and a non-breaking space, as pasted from a publisher's catalogue.
    ["978–0306406157", "9780306406157"],
    ["978 0306406157", "9780306406157"],
    ["9791034304233", "9791034304233"],
    ["979-10-343-0423-3", "9791034304233"],
  ])("accepts ISBN-13 %j as %s", (input, expected) => {
    expect(normaliseIsbn(input)).toBe(expected);
  });

  it.each([
    ["0306406152", "9780306406157"],
    ["0-306-40615-2", "9780306406157"],
    ["080442957X", "9780804429573"],
    ["080442957x", "9780804429573"],
    ["0-8044-2957-X", "9780804429573"],
    ["123456789X", "9781234567897"],
  ])("converts ISBN-10 %j to %s", (input, expected) => {
    expect(normaliseIsbn(input)).toBe(expected);
  });

  it.each([
    ["9780306406158", "ISBN-13 with a wrong check digit"],
    ["0306406153", "ISBN-10 with a wrong check digit"],
    ["0804429571", "ISBN-10 whose check digit should be X"],
    [
      "5012345678900",
      "a valid EAN-13 that is not in the 978/979 Bookland range",
    ],
    ["978030640615", "12 digits"],
    ["97803064061570", "14 digits"],
    ["X306406152", "X anywhere but the ISBN-10 check digit"],
    ["978030640615X", "X on an ISBN-13"],
    ["ISBN 9780306406157", "a prefix label"],
    ["978.0306.40615.7", "dots, which are not ISBN formatting"],
    ["POPPY-PB", "a SKU"],
    ["", "empty"],
    ["   ", "blank"],
    ["９７８０３０６４０６１５７", "full-width digits"],
  ])("rejects %j (%s)", (input) => {
    expect(normaliseIsbn(input)).toBeNull();
  });
});

describe("isValidIsbn13 / isValidIsbn10", () => {
  it("checks the ISBN-13 checksum and Bookland prefix on bare digits only", () => {
    expect(isValidIsbn13("9780306406157")).toBe(true);
    expect(isValidIsbn13("9780306406158")).toBe(false);
    expect(isValidIsbn13("5012345678900")).toBe(false);
    expect(isValidIsbn13("978-0306406157")).toBe(false);
  });

  it("checks the ISBN-10 checksum including an upper-case X", () => {
    expect(isValidIsbn10("0306406152")).toBe(true);
    expect(isValidIsbn10("080442957X")).toBe(true);
    expect(isValidIsbn10("080442957x")).toBe(false);
    expect(isValidIsbn10("0306406153")).toBe(false);
  });
});
