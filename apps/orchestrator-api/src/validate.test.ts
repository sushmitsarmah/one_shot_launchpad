import { describe, expect, test } from "bun:test";
import { hasErrors, ideaErrors, rotateHue, runErrors, shufflePalette, type LaunchIdea } from "@osl/schema";

const idea = (name: string, ticker: string, o: Partial<LaunchIdea> = {}): LaunchIdea => ({
  name,
  ticker,
  tagline: "a tagline",
  description: "A description that is long enough.",
  colors: { primary: "#ff0000", secondary: "#00ff00", accent: "#0000ff", background: "#000000", text: "#ffffff" },
  ...o,
});

describe("edited idea validation", () => {
  test("field rules mirror the factory / schema", () => {
    expect(ideaErrors(idea("Moon Cat", "mooncat"))).toEqual({});
    expect(ideaErrors(idea("M", "mooncat")).name).toBeDefined();
    expect(ideaErrors(idea("   ", "mooncat")).name).toBeDefined();
    expect(ideaErrors(idea("x".repeat(41), "mooncat")).name).toBeDefined();
    expect(ideaErrors(idea("Moon Cat", "1moon")).ticker).toBeDefined();
    expect(ideaErrors(idea("Moon Cat", "m")).ticker).toBeDefined();
    expect(ideaErrors(idea("Moon Cat", "abcdefghijklmnopq")).ticker).toBeDefined();
    expect(ideaErrors(idea("Moon Cat", "moon_cat")).ticker).toBeDefined();
    expect(ideaErrors(idea("Moon Cat", "mooncat", { description: "short" })).description).toBeDefined();
    expect(ideaErrors(idea("Moon Cat", "mooncat", { tagline: "x".repeat(121) })).tagline).toBeDefined();
    expect(ideaErrors(idea("Moon Cat", "mooncat", { colors: { ...idea("a", "b").colors, text: "white" } })).colors).toBeDefined();
  });
  test("JustHoot: tickers up to 10", () => {
    expect(ideaErrors(idea("Moon Cat", "mooncatsrule"), { venue: "justhoot" }).ticker).toContain("10");
    expect(ideaErrors(idea("Moon Cat", "mooncatsrule"), { venue: "none" })).toEqual({});
  });
  test("duplicates among selected ideas only", () => {
    const list = [idea("Moon Cat", "moon"), idea("moon cat ", "moon"), idea("Sun Dog", "moon")];
    const e = runErrors(list, [true, true, false]);
    expect(e[0]).toEqual({});
    expect(e[1].name).toContain("#1");
    expect(e[1].ticker).toContain("#1");
    expect(e[2]).toEqual({});
    expect(runErrors(list).filter(hasErrors).length).toBe(2);
  });
  test("new icon colours: valid hex, background/text kept", () => {
    expect(rotateHue("#ff0000", 120)).toBe("#00ff00");
    const s = shufflePalette(idea("Moon Cat", "moon"));
    expect(ideaErrors(s)).toEqual({});
    expect(s.colors.background).toBe("#000000");
    expect(s.colors.primary).not.toBe("#ff0000");
  });
});
