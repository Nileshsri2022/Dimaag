import { describe, expect, it } from "vitest";
import { isSensitive } from "../src/lib/guardrail";

describe("isSensitive", () => {
  it("warns on mail hosts", () => {
    expect(isSensitive("https://mail.google.com/u/0")).toBe(true);
  });

  it("warns on banking hosts (hostname contains bank)", () => {
    expect(isSensitive("https://www.bankofindia.co.in/login")).toBe(true);
  });

  it("warns on paypal host labels", () => {
    expect(isSensitive("https://app.paypal.com/x")).toBe(true);
  });

  it("warns on credential-ish paths even on harmless hosts", () => {
    expect(isSensitive("https://api.test/v1/auth/token")).toBe(true);
  });

  it("warns on financial-domain hosts via path-vs-host split", () => {
    expect(isSensitive("https://bankdocs.example.com/manual")).toBe(true);
  });

  it("does not warn on documentation pages", () => {
    expect(isSensitive("https://docs.neo4j.com/cypher/manual")).toBe(false);
  });

  it("does not warn on content pages about banking (wikipedia)", () => {
    // Load-bearing intent pin: 'Bank' in the path is not a credential-ish signal.
    expect(isSensitive("https://en.wikipedia.org/wiki/Bank")).toBe(false);
  });

  it("does not warn on ordinary dev-content pages", () => {
    expect(isSensitive("https://github.com/facebook/react")).toBe(false);
  });

  it("returns false for non-URL input instead of throwing", () => {
    expect(isSensitive("not a url")).toBe(false);
  });

  it("only accepts plain http/https URLs", () => {
    expect(isSensitive("ftp://bank.example.com/login")).toBe(false);
    expect(isSensitive("mailto:bank@bank.example.com")).toBe(false);
  });
});
